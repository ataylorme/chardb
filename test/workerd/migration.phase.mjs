import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { writeJsonAtomically } from "../../scripts/browser-proof-report.mjs";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { runCli } from "../../src/cli/run.ts";

const CONTROL_SCHEMA = "chardb.migration-workerd-phase-control.v1";
const RESULT_SCHEMA = "chardb.migration-workerd-phase-result.v1";
const ADMIN_TOKEN = "workerd-migration-secret";
const WORKER_NAME = "migration-upgrade-worker";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function parseControlPath(argv) {
    const index = argv.indexOf("--control");
    const value = index < 0 ? undefined : argv[index + 1];
    if (!value || argv.length !== 2) throw new Error("usage: bun migration.phase.mjs --control <path>");
    return resolve(value);
}

async function readControl(path) {
    const control = JSON.parse(await readFile(path, "utf8"));
    assert(control?.schema === CONTROL_SCHEMA, `migration phase control schema must be ${CONTROL_SCHEMA}`);
    assert(typeof control.scriptPath === "string" && control.scriptPath.length > 0, "migration phase lacks scriptPath");
    assert(
        typeof control.persistencePath === "string" && control.persistencePath.length > 0,
        "migration phase lacks persistencePath"
    );
    assert(typeof control.resultPath === "string" && control.resultPath.length > 0, "migration phase lacks resultPath");
    assert(Array.isArray(control.actions) && control.actions.length > 0, "migration phase requires actions");
    const names = control.actions.map(action => action?.name);
    assert(
        names.every(name => typeof name === "string" && name.length > 0) && new Set(names).size === names.length,
        "migration phase action names must be unique"
    );
    return control;
}

async function dispatch(mf, pathname, body, migration = false) {
    const response = await mf.dispatchFetch(`http://example.com${migration ? "/_chardb/migrations" : ""}${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            ...(migration ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
    return await response.json();
}

async function dispatchExpectedMigrationError(mf, pathname, body) {
    const response = await mf.dispatchFetch(`http://example.com/_chardb/migrations${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert(!response.ok, `${pathname} unexpectedly succeeded`);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${pathname} returned non-JSON error ${response.status}: ${text}`);
    }
    return { status: response.status, body: parsed };
}

async function migrate(baseUrl, action) {
    let out = "";
    let err = "";
    const ctx = {
        cwd: import.meta.dir,
        env: { CHARDB_ADMIN_TOKEN: ADMIN_TOKEN },
        stdout: value => {
            out += value;
        },
        stderr: value => {
            err += value;
        },
        async read() {
            throw new Error("migration CLI should not read files");
        },
        async write() {
            throw new Error("migration CLI should not write files");
        },
        async exists() {
            return false;
        },
        fetch: globalThis.fetch,
    };
    const argv = [
        "migrate",
        "--url",
        baseUrl.origin,
        "--id",
        action.migrationId,
        "--target",
        String(action.targetVersion),
        "--concurrency",
        "2",
        ...(action.baseline ? ["--baseline"] : []),
    ];
    const code = await runCli(ctx, argv);
    if (code !== 0) throw new Error(`migration CLI exited ${code}; stdout=${out}; stderr=${err}`);
    return { out, err };
}

async function executeAction(mf, origin, action) {
    if (action.type === "call") return await dispatch(mf, action.pathname, action.body);
    if (action.type === "migration-call") return await dispatch(mf, action.pathname, action.body, true);
    if (action.type === "expect-migration-error") {
        return await dispatchExpectedMigrationError(mf, action.pathname, action.body);
    }
    if (action.type === "migrate") return await migrate(origin, action);
    if (action.type === "wait") {
        assert(Number.isSafeInteger(action.ms) && action.ms >= 0 && action.ms <= 5_000, "wait must be 0..5000ms");
        await new Promise(resolvePromise => setTimeout(resolvePromise, action.ms));
        return { waitedMs: action.ms };
    }
    if (action.type === "evict") {
        await mf.unsafeEvictDurableObject(WORKER_NAME, action.className, { name: action.nameFromId });
        return { evicted: true };
    }
    if (action.type === "expect-closed") {
        try {
            const response = await mf.dispatchFetch(`http://example.com${action.pathname}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(action.body),
            });
            return { closed: !response.ok };
        } catch {
            return { closed: true };
        }
    }
    throw new Error(`unknown migration phase action ${JSON.stringify(action.type)}`);
}

async function main() {
    const control = await readControl(parseControlPath(process.argv.slice(2)));
    let mf;
    let failure;
    try {
        mf = new Miniflare({
            name: WORKER_NAME,
            modules: true,
            script: await readFile(control.scriptPath, "utf8"),
            bindings: { CDB_ADMIN_TOKEN: ADMIN_TOKEN },
            durableObjects: {
                CDB_CATALOG: { className: "Catalog", useSQLite: true },
                CDB_GATEWAY: { className: "Gateway", useSQLite: true },
                CDB_SHARD: { className: "Cdb", useSQLite: true },
            },
            durableObjectsPersist: control.persistencePath,
            compatibilityDate: "2025-09-01",
            compatibilityFlags: ["nodejs_compat"],
        });
        const origin = await Promise.race([
            mf.ready,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("migration phase readiness timed out")), 15_000)
            ),
        ]);
        const values = {};
        for (const action of control.actions) values[action.name] = await executeAction(mf, origin, action);
        await writeJsonAtomically(control.resultPath, {
            schema: RESULT_SCHEMA,
            release: control.release,
            producerPid: process.pid,
            values,
        });
    } catch (error) {
        failure = error;
    } finally {
        const current = mf;
        mf = undefined;
        await disposeMiniflareBounded(current, { label: `migration ${control.release} phase cleanup` });
    }
    if (failure) throw failure;
}

try {
    await main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
process.exit(0);
