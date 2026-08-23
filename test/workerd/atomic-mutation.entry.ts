import { DurableObject } from "cloudflare:workers";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { isCdbError } from "../../src/errors.ts";
import { SHARD_BOOTSTRAP_DDL } from "../../src/oplog/schema.ts";
import { executeAtomicMutation } from "../../src/server/atomic-mutation.ts";
import { forOrg, globalScope } from "../../src/server/cdb-tenant.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";

const { cdbTable: globalTable } = globalScope();
const entries = globalTable(
    "atomic_entries",
    {
        id: text("id").primaryKey(),
        sequence: integer("sequence").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*" } } }
);

const auxEntries = globalTable(
    "atomic_aux_entries",
    {
        id: text("id").primaryKey(),
        sequence: integer("sequence").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*" } } }
);

const schema = { entries, auxEntries };

const organization = sqliteTable("atomic_organization", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const securedEntries = cdbTable(
    "atomic_secured_entries",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        secretNote: text("secret_note"),
    },
    { tenantBy: "organizationId", roles: { member: { create: ["id"], update: ["id"] } } }
);

const securedSchema = { entries, securedEntries };

interface ExecuteArgs {
    readonly mode: "commit" | "throw" | "async" | "forbidden" | "policy" | "updatePolicy" | "deletePolicy";
    readonly mutId: string;
    readonly firstId: string;
    readonly secondId: string;
}

type ProbeEnv = Record<string, never>;

export class AtomicMutationProbe extends DurableObject<ProbeEnv> {
    constructor(state: DurableObjectState, env: ProbeEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const statement of SHARD_BOOTSTRAP_DDL.split(";")
                .map(s => s.trim())
                .filter(Boolean)) {
                sql.exec(statement);
            }
            sql.exec("CREATE TABLE IF NOT EXISTS atomic_entries (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL)");
            sql.exec("CREATE TABLE IF NOT EXISTS atomic_aux_entries (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL)");
            sql.exec(
                "CREATE TABLE IF NOT EXISTS atomic_secured_entries (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, secret_note TEXT)"
            );
        });
    }

    execute(args: ExecuteArgs): {
        readonly cookie: string;
        readonly ran: boolean;
        readonly result: unknown;
        readonly rowsAffected: number;
        readonly touchedTables: readonly string[];
    } {
        const common = {
            storage: this.ctx.storage,
            schema,
            request: {
                principalId: "probe-user",
                mutId: args.mutId,
                ref: "src/probe.ts#writePair",
                args: { firstId: args.firstId, secondId: args.secondId },
                auth: { userId: "probe-user", tenantId: "probe-org", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
            },
            cookie: `probe:${args.mutId}`,
            nowMs: 1_700_000_000_000,
        } as const;

        if (args.mode === "async") {
            const asyncHandler = async ({
                db,
            }: Parameters<Parameters<typeof executeAtomicMutation>[0]["handler"]>[0]) => {
                db.insert(entries).values({ id: args.firstId, sequence: 1 }).run();
                return { ids: [args.firstId] };
            };
            try {
                return executeAtomicMutation({
                    ...common,
                    handler: asyncHandler as never,
                });
            } catch (error) {
                if (!isCdbError(error)) throw error;
                return { error: { code: error.code, message: error.message } } as never;
            }
        }

        try {
            return executeAtomicMutation({
                ...common,
                schema:
                    args.mode === "forbidden" ||
                    args.mode === "policy" ||
                    args.mode === "updatePolicy" ||
                    args.mode === "deletePolicy"
                        ? securedSchema
                        : schema,
                handler: ({ db }) => {
                    db.insert(entries).values({ id: args.firstId, sequence: 1 }).run();
                    if (args.mode === "forbidden") {
                        db.insert(securedEntries).values({ id: args.secondId, organizationId: "unverified-org" }).run();
                    }
                    if (args.mode === "policy") {
                        db.insert(securedEntries).values({ id: args.secondId, secretNote: "forbidden" }).run();
                    }
                    if (args.mode === "updatePolicy") {
                        db.update(securedEntries).set({ secretNote: "forbidden" }).run();
                    }
                    if (args.mode === "deletePolicy") {
                        db.delete(securedEntries).run();
                    }
                    if (args.mode === "commit") {
                        db.insert(auxEntries).values({ id: args.mutId, sequence: 1 }).run();
                    }
                    db.insert(entries).values({ id: args.secondId, sequence: 2 }).run();
                    if (args.mode === "throw") throw new Error("probe failure after second statement");
                    return { ids: [args.firstId, args.secondId] };
                },
            });
        } catch (error) {
            if (!isCdbError(error)) throw error;
            return { error: { code: error.code, message: error.message } } as never;
        }
    }

    inspect(): { readonly entries: readonly { id: string; sequence: number }[]; readonly opLogRows: number } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const rows = sql.all<{ id: string; sequence: number }>(
            "SELECT id, sequence FROM atomic_entries ORDER BY sequence, id"
        );
        const count = sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_op_log");
        return { entries: rows, opLogRows: count?.count ?? 0 };
    }
}

interface Env {
    readonly ATOMIC: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const id = env.ATOMIC.idFromName("atomic-probe");
        const stub = env.ATOMIC.get(id) as unknown as {
            execute(args: ExecuteArgs): Promise<unknown>;
            inspect(): Promise<unknown>;
        };
        try {
            if (new URL(request.url).pathname === "/inspect") return Response.json(await stub.inspect());
            const result = await stub.execute((await request.json()) as ExecuteArgs);
            if (result && typeof result === "object" && "error" in result) {
                return Response.json((result as { error: unknown }).error, { status: 409 });
            }
            return Response.json(result);
        } catch (error) {
            const e = error as { code?: string; message?: string };
            return Response.json({ code: e.code ?? "UNKNOWN", message: e.message ?? String(error) }, { status: 409 });
        }
    },
};
