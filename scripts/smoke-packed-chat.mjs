import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT = join(ROOT, "example", "chat");
const tarball = resolve(process.argv[2] ?? "");
const ADMIN_TOKEN = "packed-chat-migration-secret";
const BINDING_BENCHMARK_PROFILES = {
    "ci-smoke": { queries: 32, concurrency: 8 },
    throughput: { queries: 256, concurrency: 32 },
};
const bindingBenchmarkProfileName = process.env.CDB_BINDING_BENCH_PROFILE ?? "ci-smoke";
const bindingBenchmarkProfile = BINDING_BENCHMARK_PROFILES[bindingBenchmarkProfileName];
if (!bindingBenchmarkProfile) {
    throw new Error(`unknown CDB_BINDING_BENCH_PROFILE ${JSON.stringify(bindingBenchmarkProfileName)}`);
}
const LOOPBACK_DURABLE_OBJECTS = {
    Catalog: { className: "Catalog", useSQLite: true },
    Gateway: { className: "Gateway", useSQLite: true },
    Cdb: { className: "Cdb", useSQLite: true },
    BlobMeta: { className: "BlobMeta", useSQLite: true },
    Resharder: { className: "Resharder", useSQLite: true },
    GsiShard: { className: "GsiShard", useSQLite: true },
};

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

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
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

async function connectGateway(origin, clientId, jwt) {
    const wsUrl = new URL(`/ws?clientId=${encodeURIComponent(clientId)}`, origin);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl);
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
    socket.send(JSON.stringify({ t: "hello", protocolV: 3, clientId, jwt }));
    const welcome = await next(message => message.t === "welcome" || message.t === "error");
    assert(welcome.t === "welcome", `Gateway rejected Better Auth JWT: ${JSON.stringify(welcome)}`);
    return { socket, next };
}

async function closeSocket(socket) {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolvePromise => {
        const timeout = setTimeout(resolvePromise, 5_000);
        socket.addEventListener(
            "close",
            () => {
                clearTimeout(timeout);
                resolvePromise();
            },
            { once: true }
        );
        socket.close();
    });
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

async function migratePackedWorker(consumer, origin) {
    const proc = Bun.spawn(
        [
            "bun",
            join(consumer, "node_modules", "chardb", "dist", "cli", "bin.mjs"),
            "migrate",
            "--url",
            origin.origin,
            "--id",
            "packed-chat-initial-schema",
            "--target",
            "1",
            "--concurrency",
            "2",
        ],
        {
            cwd: consumer,
            env: { ...process.env, CHARDB_ADMIN_TOKEN: ADMIN_TOKEN },
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    assert(exitCode === 0, `packed migration failed (${exitCode})\n${stdout}${stderr}`);
    assert(stdout.includes("schema version 1 active at epoch 2"), `packed migration output drifted: ${stdout}`);
}

async function main() {
    assert(
        Object.keys(LOOPBACK_DURABLE_OBJECTS).every(name => !name.startsWith("CDB_")),
        "packed chat must provision Miniflare by exported class name, not legacy CDB_* binding"
    );
    const scratch = await mkdtemp(join(tmpdir(), "chardb-packed-chat-"));
    const consumer = join(scratch, "consumer");
    const persistencePath = join(scratch, "durable-objects");
    let mf;
    const sockets = [];
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
        assert(built.includes("src/server/api.ts#createUserPreference"), "Vite output lost the user mutation ref");
        assert(built.includes("src/server/queries.ts#listUserPreferences"), "Vite output lost the user query ref");

        const bundlePath = join(scratch, "chat-worker.mjs");
        const worker = await bundleWorker(consumer, bundlePath);
        const startMiniflare = () =>
            new Miniflare({
                modules: true,
                script: worker,
                bindings: {
                    BETTER_AUTH_SECRET: "packed-chat-secret-that-is-at-least-32-characters",
                    CDB_ADMIN_TOKEN: ADMIN_TOKEN,
                },
                durableObjects: LOOPBACK_DURABLE_OBJECTS,
                durableObjectsPersist: persistencePath,
                compatibilityDate: "2026-05-10",
                compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
            });
        mf = startMiniflare();
        let origin = await mf.ready;
        await migratePackedWorker(consumer, origin);

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

        let primary = await connectGateway(origin, "packed-chat-client", tokenBody.token);
        let { socket, next } = primary;
        sockets.push(socket);

        const secondSignIn = await mf.dispatchFetch(new URL("/api/auth/sign-in/anonymous", origin), {
            method: "POST",
            headers: { "content-type": "application/json", origin: origin.origin },
            body: "{}",
        });
        const secondSignInText = await secondSignIn.text();
        assert(secondSignIn.ok, `second anonymous sign-in failed (${secondSignIn.status}): ${secondSignInText}`);
        const secondCookie = sessionCookies(secondSignIn.headers);
        assert(secondCookie.length > 0, "second anonymous sign-in returned no session cookie");
        const secondSession = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), {
            headers: { cookie: secondCookie },
        });
        const secondSessionBody = await secondSession.json();
        assert(
            secondSession.ok &&
                typeof secondSessionBody?.user?.id === "string" &&
                secondSessionBody.user.id !== sessionBody.user.id &&
                secondSessionBody?.session?.activeOrganizationId === "demo-org",
            `second session did not start in demo-org: ${JSON.stringify(secondSessionBody)}`
        );
        const secondUserId = secondSessionBody.user.id;
        const demoMembersResponse = await mf.dispatchFetch(
            new URL("/api/auth/organization/list-members?organizationId=demo-org", origin),
            { headers: { cookie } }
        );
        const demoMembers = await demoMembersResponse.json();
        assert(
            demoMembersResponse.ok &&
                demoMembers?.total === 2 &&
                Array.isArray(demoMembers?.members) &&
                demoMembers.members.some(member => member.userId === sessionBody.user.id) &&
                demoMembers.members.some(member => member.userId === secondUserId),
            `demo organization membership lookup failed: ${JSON.stringify(demoMembers)}`
        );
        const secondTokenResponse = await mf.dispatchFetch(new URL("/api/auth/token", origin), {
            headers: { cookie: secondCookie },
        });
        const secondTokenBody = await secondTokenResponse.json();
        assert(
            secondTokenResponse.ok && typeof secondTokenBody?.token === "string",
            `second JWT issue failed: ${JSON.stringify(secondTokenBody)}`
        );
        const observer = await connectGateway(origin, "packed-chat-observer", secondTokenBody.token);
        sockets.push(observer.socket);

        const preferenceMutationRequest = {
            id: "packed-user-preference",
            userId: sessionBody.user.id,
            theme: "dark",
            mutId: "packed-user-preference-mut",
        };
        const preferenceMutation = await mf.dispatchFetch(new URL("/api/db/preferences", origin), {
            method: "POST",
            headers: {
                authorization: `Bearer ${tokenBody.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(preferenceMutationRequest),
        });
        const preferenceMutationBody = await preferenceMutation.json();
        assert(
            preferenceMutation.ok &&
                preferenceMutationBody?.id === "packed-user-preference" &&
                preferenceMutationBody?.userId === sessionBody.user.id,
            `native env.DB user mutation failed: ${JSON.stringify(preferenceMutationBody)}`
        );
        const primaryPreferenceUrl = new URL("/api/db/preferences", origin);
        primaryPreferenceUrl.searchParams.set("userId", sessionBody.user.id);
        const secondPreferenceUrl = new URL("/api/db/preferences", origin);
        secondPreferenceUrl.searchParams.set("userId", secondUserId);
        const [primaryPreferenceResponse, secondPreferenceResponse] = await Promise.all([
            mf.dispatchFetch(primaryPreferenceUrl, {
                headers: { authorization: `Bearer ${tokenBody.token}` },
            }),
            mf.dispatchFetch(secondPreferenceUrl, {
                headers: { authorization: `Bearer ${secondTokenBody.token}` },
            }),
        ]);
        const [primaryPreferences, secondPreferences] = await Promise.all([
            primaryPreferenceResponse.json(),
            secondPreferenceResponse.json(),
        ]);
        assert(
            primaryPreferenceResponse.ok &&
                Array.isArray(primaryPreferences) &&
                primaryPreferences.length === 1 &&
                primaryPreferences[0]?.theme === "dark",
            `native env.DB user query failed: ${JSON.stringify(primaryPreferences)}`
        );
        assert(
            secondPreferenceResponse.ok && Array.isArray(secondPreferences) && secondPreferences.length === 0,
            `native env.DB cross-user isolation failed: ${JSON.stringify(secondPreferences)}`
        );
        const forgedPreferenceResponse = await mf.dispatchFetch(secondPreferenceUrl, {
            headers: { authorization: `Bearer ${tokenBody.token}` },
        });
        assert(!forgedPreferenceResponse.ok, "native env.DB accepted a forged user partition");

        const preferenceReplay = await mf.dispatchFetch(new URL("/api/db/preferences", origin), {
            method: "POST",
            headers: {
                authorization: `Bearer ${tokenBody.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(preferenceMutationRequest),
        });
        const preferenceReplayBody = await preferenceReplay.json();
        assert(
            preferenceReplay.ok && JSON.stringify(preferenceReplayBody) === JSON.stringify(preferenceMutationBody),
            `native env.DB user mutation replay changed its result: ${JSON.stringify(preferenceReplayBody)}`
        );

        const userQueryLatenciesMs = [];
        const userBenchmarkStartedAt = performance.now();
        for (let offset = 0; offset < bindingBenchmarkProfile.queries; offset += bindingBenchmarkProfile.concurrency) {
            const batchSize = Math.min(bindingBenchmarkProfile.concurrency, bindingBenchmarkProfile.queries - offset);
            await Promise.all(
                Array.from({ length: batchSize }, async (_, batchIndex) => {
                    const primary = (offset + batchIndex) % 2 === 0;
                    const startedAt = performance.now();
                    const response = await mf.dispatchFetch(primary ? primaryPreferenceUrl : secondPreferenceUrl, {
                        headers: {
                            authorization: `Bearer ${primary ? tokenBody.token : secondTokenBody.token}`,
                        },
                    });
                    const rows = await response.json();
                    userQueryLatenciesMs.push(performance.now() - startedAt);
                    assert(
                        response.ok && Array.isArray(rows) && rows.length === (primary ? 1 : 0),
                        `native env.DB user benchmark diverged: ${JSON.stringify(rows)}`
                    );
                })
            );
        }
        const userBenchmarkElapsedMs = performance.now() - userBenchmarkStartedAt;
        const sortedUserQueryLatenciesMs = [...userQueryLatenciesMs].sort((left, right) => left - right);
        console.log(
            JSON.stringify({
                type: "chardb-user-binding-benchmark",
                version: 1,
                profile: bindingBenchmarkProfileName,
                principals: 2,
                queries: bindingBenchmarkProfile.queries,
                concurrency: bindingBenchmarkProfile.concurrency,
                elapsedMs: userBenchmarkElapsedMs,
                queriesPerSecond: (bindingBenchmarkProfile.queries * 1_000) / userBenchmarkElapsedMs,
                latencyMs: {
                    min: sortedUserQueryLatenciesMs[0],
                    p50: percentile(sortedUserQueryLatenciesMs, 0.5),
                    p95: percentile(sortedUserQueryLatenciesMs, 0.95),
                    max: sortedUserQueryLatenciesMs.at(-1),
                },
                invariants: {
                    exactPrimaryRowsPerQuery: 1,
                    exactSecondUserRowsPerQuery: 0,
                    forgedPartitionDenied: true,
                    mutationReplayStable: true,
                },
            })
        );

        const queryArgs = { organizationId: "demo-org", channelId: "general", limit: 50 };
        socket.send(JSON.stringify({ t: "sub", subId: 1, ref: "src/server/queries.ts#listMessages", args: queryArgs }));
        observer.socket.send(
            JSON.stringify({ t: "sub", subId: 1, ref: "src/server/queries.ts#listMessages", args: queryArgs })
        );
        const initial = await next(
            message => (message.t === "snapshot" && message.subId === 1) || message.t === "error"
        );
        const observerInitial = await observer.next(
            message => (message.t === "snapshot" && message.subId === 1) || message.t === "error"
        );
        assert(
            initial.t === "snapshot" && initial.rows.length === 0,
            `initial snapshot failed: ${JSON.stringify(initial)}`
        );
        assert(
            observerInitial.t === "snapshot" && observerInitial.rows.length === 0,
            `second client initial snapshot failed: ${JSON.stringify(observerInitial)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: initial.cookie }));
        observer.socket.send(JSON.stringify({ t: "ack", cookie: observerInitial.cookie }));

        const mutationRequest = {
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
        };
        socket.send(JSON.stringify(mutationRequest));
        const mutation = await next(
            message => message.t === "error" || message.mutResults?.some(result => result.mutId === "packed-chat-mut-1")
        );
        const result = mutation.mutResults?.find(entry => entry.mutId === "packed-chat-mut-1");
        assert(result?.ok === true, `packed mutation failed: ${JSON.stringify(mutation)}`);
        const replacement = await next(
            message =>
                (message.t === "snapshot" && message.subId === 1 && message.rows.length === 1) || message.t === "error"
        );
        const observerReplacement = await observer.next(
            message =>
                (message.t === "snapshot" && message.subId === 1 && message.rows.length === 1) || message.t === "error"
        );
        assert(
            replacement.t === "snapshot" && replacement.rows[0]?.body === "packed hello",
            `live replacement failed: ${JSON.stringify(replacement)}`
        );
        assert(
            observerReplacement.t === "snapshot" &&
                observerReplacement.rows.length === 1 &&
                observerReplacement.rows[0]?.id === "packed-message-1" &&
                observerReplacement.rows[0]?.organizationId === "demo-org" &&
                observerReplacement.rows[0]?.body === "packed hello",
            `second same-organization client missed the live replacement: ${JSON.stringify(observerReplacement)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: replacement.cookie }));
        observer.socket.send(JSON.stringify({ t: "ack", cookie: observerReplacement.cookie }));

        const bindingQueryUrl = new URL("/api/db/messages?organizationId=demo-org&channelId=general&limit=50", origin);
        const bindingQuery = await mf.dispatchFetch(bindingQueryUrl, {
            headers: { authorization: `Bearer ${tokenBody.token}` },
        });
        const bindingRows = await bindingQuery.json();
        assert(
            bindingQuery.ok &&
                Array.isArray(bindingRows) &&
                bindingRows.length === 1 &&
                bindingRows[0]?.id === "packed-message-1",
            `native env.DB query failed: ${JSON.stringify(bindingRows)}`
        );

        const bindingMutation = await mf.dispatchFetch(new URL("/api/db/messages", origin), {
            method: "POST",
            headers: {
                authorization: `Bearer ${tokenBody.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                id: "packed-binding-message-2",
                organizationId: "demo-org",
                channelId: "general",
                body: "env.DB hello",
                clientCreatedAt: 2,
                mutId: "packed-binding-mut-2",
            }),
        });
        const bindingMutationBody = await bindingMutation.json();
        assert(
            bindingMutation.ok && bindingMutationBody?.id === "packed-binding-message-2",
            `native env.DB mutation failed: ${JSON.stringify(bindingMutationBody)}`
        );
        const bindingReplacement = await next(
            message =>
                (message.t === "snapshot" && message.subId === 1 && message.rows.length === 2) || message.t === "error"
        );
        const observerBindingReplacement = await observer.next(
            message =>
                (message.t === "snapshot" && message.subId === 1 && message.rows.length === 2) || message.t === "error"
        );
        assert(
            bindingReplacement.t === "snapshot" &&
                bindingReplacement.rows.some(row => row.id === "packed-binding-message-2"),
            `env.DB mutation did not invalidate the live query: ${JSON.stringify(bindingReplacement)}`
        );
        assert(
            observerBindingReplacement.t === "snapshot" &&
                observerBindingReplacement.rows.some(row => row.id === "packed-binding-message-2"),
            `env.DB mutation did not reach the second client: ${JSON.stringify(observerBindingReplacement)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: bindingReplacement.cookie }));
        observer.socket.send(JSON.stringify({ t: "ack", cookie: observerBindingReplacement.cookie }));

        const bindingReplay = await mf.dispatchFetch(new URL("/api/db/messages", origin), {
            method: "POST",
            headers: {
                authorization: `Bearer ${tokenBody.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                id: "packed-binding-message-2",
                organizationId: "demo-org",
                channelId: "general",
                body: "env.DB hello",
                clientCreatedAt: 2,
                mutId: "packed-binding-mut-2",
            }),
        });
        const bindingReplayBody = await bindingReplay.json();
        assert(
            bindingReplay.ok && JSON.stringify(bindingReplayBody) === JSON.stringify(bindingMutationBody),
            `native env.DB mutation replay changed its result: ${JSON.stringify(bindingReplayBody)}`
        );

        const queryLatenciesMs = [];
        const benchmarkStartedAt = performance.now();
        for (let offset = 0; offset < bindingBenchmarkProfile.queries; offset += bindingBenchmarkProfile.concurrency) {
            const batchSize = Math.min(bindingBenchmarkProfile.concurrency, bindingBenchmarkProfile.queries - offset);
            await Promise.all(
                Array.from({ length: batchSize }, async () => {
                    const startedAt = performance.now();
                    const response = await mf.dispatchFetch(bindingQueryUrl, {
                        headers: { authorization: `Bearer ${tokenBody.token}` },
                    });
                    const rows = await response.json();
                    queryLatenciesMs.push(performance.now() - startedAt);
                    assert(
                        response.ok &&
                            Array.isArray(rows) &&
                            rows.length === 2 &&
                            rows.some(row => row.id === "packed-message-1") &&
                            rows.some(row => row.id === "packed-binding-message-2"),
                        `native env.DB benchmark query diverged: ${JSON.stringify(rows)}`
                    );
                })
            );
        }
        const bindingBenchmarkElapsedMs = performance.now() - benchmarkStartedAt;
        const sortedQueryLatenciesMs = [...queryLatenciesMs].sort((left, right) => left - right);
        console.log(
            JSON.stringify({
                type: "chardb-binding-benchmark",
                version: 1,
                profile: bindingBenchmarkProfileName,
                queries: bindingBenchmarkProfile.queries,
                concurrency: bindingBenchmarkProfile.concurrency,
                elapsedMs: bindingBenchmarkElapsedMs,
                queriesPerSecond: (bindingBenchmarkProfile.queries * 1_000) / bindingBenchmarkElapsedMs,
                latencyMs: {
                    min: sortedQueryLatenciesMs[0],
                    p50: percentile(sortedQueryLatenciesMs, 0.5),
                    p95: percentile(sortedQueryLatenciesMs, 0.95),
                    max: sortedQueryLatenciesMs.at(-1),
                },
                invariants: {
                    exactRowsPerQuery: 2,
                    mutationReplayStable: true,
                    liveClientsConverged: 2,
                },
            })
        );

        await Promise.all([closeSocket(socket), closeSocket(observer.socket)]);
        await mf.dispose();
        mf = startMiniflare();
        origin = await mf.ready;

        const reconstructedSession = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), {
            headers: { cookie },
        });
        const reconstructedSessionBody = await reconstructedSession.json();
        assert(
            reconstructedSession.ok &&
                reconstructedSessionBody?.user?.id === sessionBody.user.id &&
                reconstructedSessionBody?.session?.id === sessionBody.session.id &&
                reconstructedSessionBody?.session?.activeOrganizationId === "demo-org",
            `packed session did not survive Miniflare restart: ${JSON.stringify(reconstructedSessionBody)}`
        );

        const reconstructedTokenResponse = await mf.dispatchFetch(new URL("/api/auth/token", origin), {
            headers: { cookie },
        });
        const reconstructedTokenBody = await reconstructedTokenResponse.json();
        assert(
            reconstructedTokenResponse.ok && typeof reconstructedTokenBody?.token === "string",
            `JWT issue from the reconstructed session failed: ${JSON.stringify(reconstructedTokenBody)}`
        );
        const reconstructedSecondTokenResponse = await mf.dispatchFetch(new URL("/api/auth/token", origin), {
            headers: { cookie: secondCookie },
        });
        const reconstructedSecondTokenBody = await reconstructedSecondTokenResponse.json();
        assert(
            reconstructedSecondTokenResponse.ok && typeof reconstructedSecondTokenBody?.token === "string",
            `second JWT issue after restart failed: ${JSON.stringify(reconstructedSecondTokenBody)}`
        );
        const reconstructedPrimaryPreferenceUrl = new URL("/api/db/preferences", origin);
        reconstructedPrimaryPreferenceUrl.searchParams.set("userId", sessionBody.user.id);
        const reconstructedSecondPreferenceUrl = new URL("/api/db/preferences", origin);
        reconstructedSecondPreferenceUrl.searchParams.set("userId", secondUserId);
        const [reconstructedPrimaryPreference, reconstructedSecondPreference] = await Promise.all([
            mf.dispatchFetch(reconstructedPrimaryPreferenceUrl, {
                headers: { authorization: `Bearer ${reconstructedTokenBody.token}` },
            }),
            mf.dispatchFetch(reconstructedSecondPreferenceUrl, {
                headers: { authorization: `Bearer ${reconstructedSecondTokenBody.token}` },
            }),
        ]);
        const [reconstructedPrimaryRows, reconstructedSecondRows] = await Promise.all([
            reconstructedPrimaryPreference.json(),
            reconstructedSecondPreference.json(),
        ]);
        assert(
            reconstructedPrimaryPreference.ok &&
                Array.isArray(reconstructedPrimaryRows) &&
                reconstructedPrimaryRows.length === 1 &&
                reconstructedPrimaryRows[0]?.id === "packed-user-preference",
            `user preference did not survive Miniflare restart: ${JSON.stringify(reconstructedPrimaryRows)}`
        );
        assert(
            reconstructedSecondPreference.ok &&
                Array.isArray(reconstructedSecondRows) &&
                reconstructedSecondRows.length === 0,
            `user isolation changed after Miniflare restart: ${JSON.stringify(reconstructedSecondRows)}`
        );

        primary = await connectGateway(origin, "packed-chat-client", reconstructedTokenBody.token);
        ({ socket, next } = primary);
        sockets.push(socket);

        socket.send(JSON.stringify(mutationRequest));
        const replay = await next(
            message => message.t === "error" || message.mutResults?.some(entry => entry.mutId === "packed-chat-mut-1")
        );
        const replayResult = replay.mutResults?.find(entry => entry.mutId === "packed-chat-mut-1");
        assert(replayResult?.ok === true, `packed mutation replay failed: ${JSON.stringify(replay)}`);
        assert(
            JSON.stringify(replayResult) === JSON.stringify(result),
            `packed mutation replay changed its result: ${JSON.stringify({ first: result, replay: replayResult })}`
        );

        socket.send(JSON.stringify({ t: "sub", subId: 2, ref: "src/server/queries.ts#listMessages", args: queryArgs }));
        const readback = await next(
            message => (message.t === "snapshot" && message.subId === 2) || message.t === "error"
        );
        assert(
            readback.t === "snapshot" &&
                readback.rows.length === 2 &&
                readback.rows.filter(row => row.id === "packed-message-1").length === 1 &&
                readback.rows.filter(row => row.id === "packed-binding-message-2").length === 1,
            `readback snapshot failed: ${JSON.stringify(readback)}`
        );
        socket.send(JSON.stringify({ t: "ack", cookie: readback.cookie }));

        const reconstructedSecondSession = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), {
            headers: { cookie: secondCookie },
        });
        const reconstructedSecondSessionBody = await reconstructedSecondSession.json();
        assert(
            reconstructedSecondSession.ok &&
                reconstructedSecondSessionBody?.user?.id === secondUserId &&
                reconstructedSecondSessionBody?.session?.activeOrganizationId === "demo-org",
            `second packed session did not survive Miniflare restart: ${JSON.stringify(reconstructedSecondSessionBody)}`
        );

        const leaveDemo = await mf.dispatchFetch(new URL("/api/auth/organization/leave", origin), {
            method: "POST",
            headers: { "content-type": "application/json", cookie: secondCookie, origin: origin.origin },
            body: JSON.stringify({ organizationId: "demo-org" }),
        });
        const leaveDemoText = await leaveDemo.text();
        assert(leaveDemo.ok, `second user could not leave demo-org (${leaveDemo.status}): ${leaveDemoText}`);

        const createOrganization = await mf.dispatchFetch(new URL("/api/auth/organization/create", origin), {
            method: "POST",
            headers: { "content-type": "application/json", cookie: secondCookie, origin: origin.origin },
            body: JSON.stringify({ name: "Packed Isolation", slug: "packed-isolation" }),
        });
        const isolationOrganization = await createOrganization.json();
        assert(
            createOrganization.ok && typeof isolationOrganization?.id === "string",
            `second organization creation failed: ${JSON.stringify(isolationOrganization)}`
        );

        const isolatedSession = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), {
            headers: { cookie: secondCookie },
        });
        const isolatedSessionBody = await isolatedSession.json();
        assert(
            isolatedSession.ok &&
                isolatedSessionBody?.user?.id === secondUserId &&
                isolatedSessionBody?.session?.activeOrganizationId === isolationOrganization.id,
            `second session did not select its organization: ${JSON.stringify(isolatedSessionBody)}`
        );
        const isolatedTokenResponse = await mf.dispatchFetch(new URL("/api/auth/token", origin), {
            headers: { cookie: secondCookie },
        });
        const isolatedTokenBody = await isolatedTokenResponse.json();
        assert(
            isolatedTokenResponse.ok && typeof isolatedTokenBody?.token === "string",
            `second JWT issue after organization move failed: ${JSON.stringify(isolatedTokenBody)}`
        );

        const isolated = await connectGateway(origin, "packed-chat-isolated-client", isolatedTokenBody.token);
        sockets.push(isolated.socket);
        isolated.socket.send(
            JSON.stringify({ t: "sub", subId: 1, ref: "src/server/queries.ts#listMessages", args: queryArgs })
        );
        const forbiddenRead = await isolated.next(
            message =>
                (message.t === "error" && message.subId === 1) || (message.t === "snapshot" && message.subId === 1)
        );
        assert(
            forbiddenRead.t === "error" && forbiddenRead.code === "CDB_FORBIDDEN",
            `second tenant read demo-org data: ${JSON.stringify(forbiddenRead)}`
        );

        const isolationArgs = { ...queryArgs, organizationId: isolationOrganization.id };
        isolated.socket.send(
            JSON.stringify({
                t: "sub",
                subId: 2,
                ref: "src/server/queries.ts#listMessages",
                args: isolationArgs,
            })
        );
        const isolatedSnapshot = await isolated.next(
            message => (message.t === "snapshot" && message.subId === 2) || message.t === "error"
        );
        assert(
            isolatedSnapshot.t === "snapshot" && isolatedSnapshot.rows.length === 0,
            `second tenant snapshot was not isolated: ${JSON.stringify(isolatedSnapshot)}`
        );
        isolated.socket.send(JSON.stringify({ t: "ack", cookie: isolatedSnapshot.cookie }));

        const isolationMembersResponse = await mf.dispatchFetch(
            new URL(`/api/auth/organization/list-members?organizationId=${isolationOrganization.id}`, origin),
            { headers: { cookie: secondCookie } }
        );
        const isolationMembers = await isolationMembersResponse.json();
        assert(
            isolationMembersResponse.ok &&
                isolationMembers?.total === 1 &&
                isolationMembers?.members?.[0]?.userId === secondUserId,
            `isolated organization membership lookup failed: ${JSON.stringify(isolationMembers)}`
        );

        for (const sessionCookie of [cookie, secondCookie]) {
            const signOut = await mf.dispatchFetch(new URL("/api/auth/sign-out", origin), {
                method: "POST",
                headers: { "content-type": "application/json", cookie: sessionCookie, origin: origin.origin },
                body: "{}",
            });
            const signOutBody = await signOut.json();
            assert(
                signOut.ok && signOutBody?.success === true,
                `packed sign-out failed: ${JSON.stringify(signOutBody)}`
            );
            const signedOutSession = await mf.dispatchFetch(new URL("/api/auth/get-session", origin), {
                headers: { cookie: sessionCookie },
            });
            assert(
                signedOutSession.ok && (await signedOutSession.json()) === null,
                "signed-out packed session remained active"
            );
        }
        console.log(`packed chat proof passed with chardb ${installed.version}`);
    } finally {
        try {
            await Promise.allSettled(sockets.map(closeSocket));
            await mf?.dispose();
        } finally {
            await rm(scratch, { recursive: true, force: true });
            await rm(tarball, { force: true });
        }
    }
}

await main();
