import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT = join(ROOT, "example", "chat");
const tarball = resolve(process.argv[2] ?? "");

if (!process.argv[2]) throw new Error("usage: bun scripts/smoke-packed-chat.mjs <package.tgz>");

function run(command, args, cwd, env = {}, stdio = ["ignore", "pipe", "pipe"]) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio,
    });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return result.stdout ?? "";
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sessionCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
    return values
        .filter(Boolean)
        .map(value => value.split(";", 1)[0])
        .join("; ");
}

function socketInbox(socket) {
    const queued = [];
    const waiters = [];
    socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data));
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(message);
        else queued.push(message);
    });
    socket.addEventListener("close", event => {
        const error = new Error(`Gateway closed (${event.code}: ${event.reason})`);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
    });
    return async function next(predicate, timeoutMs = 8_000) {
        const found = queued.findIndex(predicate);
        if (found >= 0) return queued.splice(found, 1)[0];
        const message = await new Promise((resolvePromise, reject) => {
            const waiter = { resolve: resolvePromise, reject };
            waiters.push(waiter);
            const timeout = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                reject(new Error(`timed out waiting for Gateway message; queued=${JSON.stringify(queued)}`));
            }, timeoutMs);
            waiter.resolve = value => {
                clearTimeout(timeout);
                resolvePromise(value);
            };
        });
        if (predicate(message)) return message;
        queued.push(message);
        return next(predicate, timeoutMs);
    };
}

async function bundleWorker(consumer, bundlePath) {
    run(
        "bun",
        [
            "build",
            join(consumer, "src", "server", "worker.ts"),
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundlePath,
        ],
        consumer
    );
    let source = await readFile(bundlePath, "utf8");
    source = source.replace(
        "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
        'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
    );
    source = source.replace(
        "await import(nodeSqlite)",
        'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
    );
    if (/\bimport\s*\([^"'`]/.test(source)) {
        throw new Error("chat Worker bundle contains an unsupported dynamic module specifier");
    }
    return source;
}

async function main() {
    const scratch = await mkdtemp(join(tmpdir(), "chardb-packed-chat-"));
    const consumer = join(scratch, "consumer");
    let mf;
    let socket;
    try {
        await mkdir(consumer, { recursive: true });
        await cp(join(CHAT, "src"), join(consumer, "src"), { recursive: true });
        await cp(join(CHAT, "test"), join(consumer, "test"), { recursive: true });
        for (const name of ["index.html", "tsconfig.json", "vite.config.ts"]) {
            await cp(join(CHAT, name), join(consumer, name));
        }
        const packageJson = JSON.parse(await readFile(join(CHAT, "package.json"), "utf8"));
        packageJson.dependencies.chardb = `file:${tarball}`;
        await writeFile(join(consumer, "package.json"), `${JSON.stringify(packageJson, null, 4)}\n`);

        const npmCache = process.env.CHARDDB_PACKED_CHAT_NPM_CACHE ?? join(scratch, "npm-cache");
        run(
            "npm",
            ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache],
            consumer,
            {},
            "inherit"
        );
        const installed = JSON.parse(await readFile(join(consumer, "node_modules", "chardb", "package.json"), "utf8"));
        assert(installed.name === "chardb", "packed consumer did not install chardb");

        run("npm", ["run", "build"], consumer);
        const assets = await readdir(join(consumer, "dist", "assets"));
        const built = (
            await Promise.all(
                assets
                    .filter(name => name.endsWith(".js"))
                    .map(name => readFile(join(consumer, "dist", "assets", name), "utf8"))
            )
        ).join("\n");
        assert(built.includes("src/server/api.ts#postMessage"), "Vite output lost the stable mutation ref");
        assert(built.includes("src/server/queries.ts#listMessages"), "Vite output lost the stable query ref");

        const bundlePath = join(scratch, "chat-worker.mjs");
        const worker = await bundleWorker(consumer, bundlePath);
        mf = new Miniflare({
            modules: true,
            script: worker,
            bindings: { BETTER_AUTH_SECRET: "packed-chat-secret-that-is-at-least-32-characters" },
            durableObjects: {
                CDB_CATALOG: { className: "Catalog", useSQLite: true },
                CDB_GATEWAY: { className: "Gateway", useSQLite: true },
                CDB_SHARD: { className: "Cdb", useSQLite: true },
            },
            compatibilityDate: "2025-09-01",
            compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
        });
        const origin = await mf.ready;

        const signIn = await mf.dispatchFetch(new URL("/api/auth/sign-in/anonymous", origin), {
            method: "POST",
            headers: { "content-type": "application/json", origin: origin.origin },
            body: "{}",
        });
        const signInText = await signIn.text();
        assert(signIn.ok, `anonymous sign-in failed (${signIn.status}): ${signInText}`);
        const cookie = sessionCookies(signIn.headers);
        assert(cookie.length > 0, "anonymous sign-in returned no session cookie");

        const session = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), { headers: { cookie } });
        const sessionBody = await session.json();
        assert(session.ok && sessionBody?.user?.id, `session lookup failed: ${JSON.stringify(sessionBody)}`);
        assert(
            sessionBody?.session?.activeOrganizationId === "demo-org",
            `session hook did not select demo-org: ${JSON.stringify(sessionBody)}`
        );
        const tokenResponse = await mf.dispatchFetch(new URL("/api/auth/token", origin), { headers: { cookie } });
        const tokenBody = await tokenResponse.json();
        assert(
            tokenResponse.ok && typeof tokenBody?.token === "string",
            `JWT issue failed: ${JSON.stringify(tokenBody)}`
        );

        const wsUrl = new URL("/ws?clientId=packed-chat-client", origin);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(wsUrl);
        await new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error("timed out opening Gateway WebSocket")), 5_000);
            socket.addEventListener(
                "open",
                () => {
                    clearTimeout(timeout);
                    resolvePromise();
                },
                { once: true }
            );
            socket.addEventListener(
                "error",
                () => {
                    clearTimeout(timeout);
                    reject(new Error("Gateway WebSocket failed to open"));
                },
                { once: true }
            );
        });
        const next = socketInbox(socket);
        socket.send(JSON.stringify({ t: "hello", protocolV: 3, clientId: "packed-chat-client", jwt: tokenBody.token }));
        const welcome = await next(message => message.t === "welcome" || message.t === "error");
        assert(welcome.t === "welcome", `Gateway rejected Better Auth JWT: ${JSON.stringify(welcome)}`);

        const queryArgs = { organizationId: "demo-org", channelId: "general", limit: 50 };
        socket.send(JSON.stringify({ t: "sub", subId: 1, ref: "src/server/queries.ts#listMessages", args: queryArgs }));
        const initial = await next(
            message => (message.t === "snapshot" && message.subId === 1) || message.t === "error"
        );
        assert(
            initial.t === "snapshot" && initial.rows.length === 0,
            `initial snapshot failed: ${JSON.stringify(initial)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: initial.cookie }));

        socket.send(
            JSON.stringify({
                t: "mut",
                mutId: "packed-chat-mut-1",
                ref: "src/server/api.ts#postMessage",
                args: {
                    id: "packed-message-1",
                    organizationId: "demo-org",
                    channelId: "general",
                    body: "packed hello",
                    clientCreatedAt: 1,
                },
            })
        );
        const mutation = await next(
            message => message.t === "error" || message.mutResults?.some(result => result.mutId === "packed-chat-mut-1")
        );
        const result = mutation.mutResults?.find(entry => entry.mutId === "packed-chat-mut-1");
        assert(result?.ok === true, `packed mutation failed: ${JSON.stringify(mutation)}`);
        const replacement = await next(
            message =>
                (message.t === "snapshot" && message.subId === 1 && message.rows.length === 1) || message.t === "error"
        );
        assert(
            replacement.t === "snapshot" && replacement.rows[0]?.body === "packed hello",
            `live replacement failed: ${JSON.stringify(replacement)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: replacement.cookie }));

        socket.send(JSON.stringify({ t: "sub", subId: 2, ref: "src/server/queries.ts#listMessages", args: queryArgs }));
        const readback = await next(
            message => (message.t === "snapshot" && message.subId === 2) || message.t === "error"
        );
        assert(
            readback.t === "snapshot" && readback.rows.some(row => row.id === "packed-message-1"),
            `readback snapshot failed: ${JSON.stringify(readback)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: readback.cookie }));
        console.log(`packed chat proof passed with chardb ${installed.version}`);
    } finally {
        socket?.close();
        await mf?.dispose();
        await rm(scratch, { recursive: true, force: true });
        await rm(tarball, { force: true });
    }
}

await main();
