import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    GATEWAY_REGISTRATION_DDL,
    type GatewayRegistrationAdvance,
    type GatewayRegistrationInstall,
    advanceGatewayRegistration,
    beginInitialGatewayQuery,
    cleanupGatewayRegistration,
    ensureGatewayRegistrationColumns,
    installGatewayRegistration,
    listCurrentGatewayRegistrationsForConnection,
    retireCurrentGatewayRegistration,
    retireCurrentGatewayRegistrationsForConnection,
    retireGatewayRegistration,
    settleInitialGatewaySnapshot,
} from "../../src/server/do/gateway.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, SubId, TenantId } from "../../src/types.ts";

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS changes").get() as { changes: number }).changes);
        },
    };
}

function registration(
    registrationId: string,
    principalId = "principal-1",
    overrides: Partial<GatewayRegistrationInstall> = {}
): GatewayRegistrationInstall {
    return {
        registrationId,
        principalId: PrincipalId(principalId),
        clientId: ClientId("client-shared"),
        subId: SubId(7),
        connectionId: `connection-${registrationId}`,
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { z: 1, organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        policyDigest: "policy-digest-1",
        queryHash: "query-hash-1",
        shardId: "shard-1",
        sourceCdbId: "cdb-object-1",
        schemaEpoch: 4,
        authEpochs: { global: 5, tenant: 6, principal: 7 },
        lastCookie: Cookie("cookie-0"),
        nowMs: 100,
        ...overrides,
    };
}

function advance(input: GatewayRegistrationInstall, overrides: Partial<GatewayRegistrationAdvance> = {}) {
    return {
        principalId: input.principalId,
        clientId: input.clientId,
        subId: input.subId,
        registrationId: input.registrationId,
        expectedRunVersion: 0,
        lifecycle: "active" as const,
        cdbState: "active" as const,
        dirtyVersion: 3,
        deliveredVersion: 2,
        lastCookie: Cookie("cookie-1"),
        retryCount: 2,
        retryAt: 500,
        retryError: "retryable",
        nowMs: 200,
        ...overrides,
    } satisfies GatewayRegistrationAdvance;
}

describe("Gateway durable registration generations", () => {
    let db: Database;
    let sql: SyncSql;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(GATEWAY_REGISTRATION_DDL);
        sql = syncSql(db);
    });

    afterEach(() => db.close());

    test("installs canonical state and supersedes the old generation into retiring", () => {
        const first = registration("registration-1");
        const firstInstall = db.transaction(() => installGatewayRegistration(sql, first))();
        expect(firstInstall).toEqual({ supersededRegistrationId: null });
        expect(
            (db.query("PRAGMA table_info('_gw_registration_generations')").all() as { name: string }[]).map(
                column => column.name
            )
        ).toContain("policy_digest");
        expect(
            db
                .query(
                    `SELECT connection_id, organization_id, ref, args_json, intent_json, policy_digest,
                            query_hash, shard_id,
                            source_cdb_id,
                            schema_epoch, auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
                            lifecycle, cdb_state, dirty_version, delivered_version,
                            run_token, run_target_version, run_version,
                            last_cookie, retry_count, retry_at, retry_error
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(first.registrationId)
        ).toEqual({
            connection_id: "connection-registration-1",
            organization_id: "org-1",
            ref: "queries.ts#messages",
            args_json: '{"organizationId":"org-1","z":1}',
            intent_json:
                '{"kind":"select","partitionKey":{"column":"organization_id","table":"messages","values":["org-1"]},"tables":["messages"]}',
            policy_digest: "policy-digest-1",
            query_hash: "query-hash-1",
            shard_id: "shard-1",
            source_cdb_id: "cdb-object-1",
            schema_epoch: 4,
            auth_global_epoch: 5,
            auth_tenant_epoch: 6,
            auth_principal_epoch: 7,
            lifecycle: "installing",
            cdb_state: "pending",
            dirty_version: 0,
            delivered_version: 0,
            run_token: null,
            run_target_version: null,
            run_version: 0,
            last_cookie: "cookie-0",
            retry_count: 0,
            retry_at: null,
            retry_error: null,
        });

        expect(db.transaction(() => advanceGatewayRegistration(sql, advance(first)))()).toBe(true);
        const replacement = registration("registration-2", "principal-1", { nowMs: 300 });
        expect(db.transaction(() => installGatewayRegistration(sql, replacement))()).toEqual({
            supersededRegistrationId: "registration-1",
        });

        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, run_token, run_target_version, run_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(first.registrationId)
        ).toEqual({
            lifecycle: "retiring",
            cdb_state: "retiring",
            run_token: null,
            run_target_version: null,
            run_version: 2,
        });
        expect(
            db
                .query(
                    "SELECT registration_id FROM _gw_registration_heads WHERE principal_id = ? AND client_id = ? AND sub_id = ?"
                )
                .get(replacement.principalId, replacement.clientId, replacement.subId)
        ).toEqual({ registration_id: "registration-2" });
        expect(
            db.transaction(() =>
                advanceGatewayRegistration(sql, advance(first, { expectedRunVersion: 2, nowMs: 400 }))
            )()
        ).toBe(false);
        expect(db.transaction(() => advanceGatewayRegistration(sql, advance(replacement, { nowMs: 400 })))()).toBe(
            true
        );
        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, dirty_version, delivered_version, run_token, run_version,
                            last_cookie, retry_count, retry_at, retry_error
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(replacement.registrationId)
        ).toEqual({
            lifecycle: "active",
            cdb_state: "active",
            dirty_version: 3,
            delivered_version: 2,
            run_token: null,
            run_version: 1,
            last_cookie: "cookie-1",
            retry_count: 2,
            retry_at: 500,
            retry_error: "retryable",
        });
        expect(db.transaction(() => advanceGatewayRegistration(sql, advance(replacement, { nowMs: 500 })))()).toBe(
            false
        );
    });

    test("explicit retire removes the head and retains a cleanup row", () => {
        const current = registration("registration-retire");
        db.transaction(() => installGatewayRegistration(sql, current))();
        expect(
            db.transaction(() => beginInitialGatewayQuery(sql, { ...current, changeSeq: 3, nowMs: 200 }))()
        ).toMatchObject({ baseline: 3, runVersion: 1 });

        expect(db.transaction(() => retireGatewayRegistration(sql, current, current.registrationId, 250))()).toBe(true);
        expect(db.query("SELECT * FROM _gw_registration_heads").all()).toEqual([]);
        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, delivered_version, run_token, run_target_version, run_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            lifecycle: "retiring",
            cdb_state: "retiring",
            delivered_version: 0,
            run_token: null,
            run_target_version: null,
            run_version: 2,
        });
    });

    test("isolates equal client and sub ids by principal", () => {
        const first = registration("registration-principal-1", "principal-1");
        const second = registration("registration-principal-2", "principal-2");
        db.transaction(() => installGatewayRegistration(sql, first))();
        db.transaction(() => installGatewayRegistration(sql, second))();

        expect(
            db.query("SELECT principal_id, registration_id FROM _gw_registration_heads ORDER BY principal_id").all()
        ).toEqual([
            { principal_id: "principal-1", registration_id: "registration-principal-1" },
            { principal_id: "principal-2", registration_id: "registration-principal-2" },
        ]);
        expect(db.transaction(() => retireGatewayRegistration(sql, first, first.registrationId, 300))()).toBe(true);
        expect(db.query("SELECT principal_id, registration_id FROM _gw_registration_heads").all()).toEqual([
            { principal_id: "principal-2", registration_id: "registration-principal-2" },
        ]);
    });

    test("old-generation cleanup cannot delete its replacement or current head", () => {
        const old = registration("registration-old");
        const replacement = registration("registration-new", "principal-1", { nowMs: 200 });
        db.transaction(() => {
            installGatewayRegistration(sql, old);
            installGatewayRegistration(sql, replacement);
        })();

        expect(db.transaction(() => cleanupGatewayRegistration(sql, old, old.registrationId))()).toBe(true);
        expect(db.transaction(() => cleanupGatewayRegistration(sql, replacement, replacement.registrationId))()).toBe(
            false
        );
        expect(() =>
            db
                .query("DELETE FROM _gw_registration_generations WHERE registration_id = ?")
                .run(replacement.registrationId)
        ).toThrow();
        expect(db.query("SELECT registration_id FROM _gw_registration_heads").all()).toEqual([
            { registration_id: "registration-new" },
        ]);
        expect(
            db.query("SELECT registration_id FROM _gw_registration_generations ORDER BY registration_id").all()
        ).toEqual([{ registration_id: "registration-new" }]);
    });

    test("begins an initial query without claiming delivery before snapshot settlement", () => {
        const current = registration("registration-begin");
        db.transaction(() => installGatewayRegistration(sql, current))();
        db.query("UPDATE _gw_registration_generations SET dirty_version = 9 WHERE registration_id = ?").run(
            current.registrationId
        );

        const run = db.transaction(() =>
            beginInitialGatewayQuery(sql, {
                ...current,
                changeSeq: 5,
                nowMs: 200,
            })
        )();
        expect(run).toEqual({ baseline: 9, runToken: expect.any(String), runVersion: 1 });
        expect(run?.runToken).not.toBe("");
        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, dirty_version, delivered_version,
                            run_token, run_target_version, run_version, updated_at
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            lifecycle: "installing",
            cdb_state: "active",
            dirty_version: 9,
            delivered_version: 0,
            run_token: run?.runToken,
            run_target_version: 9,
            run_version: 1,
            updated_at: 200,
        });
        expect(
            db.transaction(() => beginInitialGatewayQuery(sql, { ...current, changeSeq: 20, nowMs: 300 }))()
        ).toBeNull();

        const subscriptionAhead = registration("registration-subscription-ahead", "principal-2", {
            clientId: ClientId("client-2"),
            subId: SubId(8),
        });
        db.transaction(() => installGatewayRegistration(sql, subscriptionAhead))();
        expect(
            db.transaction(() => beginInitialGatewayQuery(sql, { ...subscriptionAhead, changeSeq: 12, nowMs: 250 }))()
        ).toMatchObject({ baseline: 12, runVersion: 1 });
    });

    test("settles only the token-owning current initial query without losing concurrent dirtiness", () => {
        const current = registration("registration-settle");
        db.transaction(() => installGatewayRegistration(sql, current))();
        const run = db.transaction(() => beginInitialGatewayQuery(sql, { ...current, changeSeq: 6, nowMs: 200 }))();
        if (!run) throw new Error("initial query did not begin");
        db.query("UPDATE _gw_registration_generations SET dirty_version = 14 WHERE registration_id = ?").run(
            current.registrationId
        );

        expect(
            db.transaction(() =>
                settleInitialGatewaySnapshot(sql, {
                    ...current,
                    runToken: "wrong-token",
                    lastCookie: Cookie("cookie-wrong"),
                    nowMs: 300,
                })
            )()
        ).toBe(false);
        expect(
            db
                .query(
                    `SELECT lifecycle, dirty_version, delivered_version, run_token, run_target_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            lifecycle: "installing",
            dirty_version: 14,
            delivered_version: 0,
            run_token: run.runToken,
            run_target_version: 6,
        });
        expect(
            db.transaction(() =>
                settleInitialGatewaySnapshot(sql, {
                    ...current,
                    connectionId: "wrong-connection",
                    runToken: run.runToken,
                    lastCookie: Cookie("cookie-wrong"),
                    nowMs: 300,
                })
            )()
        ).toBe(false);
        expect(
            db.transaction(() =>
                settleInitialGatewaySnapshot(sql, {
                    ...current,
                    runToken: run.runToken,
                    lastCookie: Cookie("cookie-settled"),
                    nowMs: 400,
                })
            )()
        ).toBe(true);
        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, dirty_version, delivered_version,
                            run_token, run_target_version, run_version, last_cookie
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            lifecycle: "active",
            cdb_state: "active",
            dirty_version: 14,
            delivered_version: 6,
            run_token: null,
            run_target_version: null,
            run_version: 2,
            last_cookie: "cookie-settled",
        });
        expect(
            db.transaction(() =>
                settleInitialGatewaySnapshot(sql, {
                    ...current,
                    runToken: run.runToken,
                    lastCookie: Cookie("cookie-replayed"),
                    nowMs: 500,
                })
            )()
        ).toBe(false);
    });

    test("an old initial-query token cannot settle after head replacement", () => {
        const old = registration("registration-cas-old");
        db.transaction(() => installGatewayRegistration(sql, old))();
        const run = db.transaction(() => beginInitialGatewayQuery(sql, { ...old, changeSeq: 2, nowMs: 200 }))();
        if (!run) throw new Error("initial query did not begin");
        const replacement = registration("registration-cas-new", "principal-1", { nowMs: 300 });
        db.transaction(() => installGatewayRegistration(sql, replacement))();

        expect(
            db.transaction(() =>
                settleInitialGatewaySnapshot(sql, {
                    ...old,
                    runToken: run.runToken,
                    lastCookie: Cookie("cookie-stale"),
                    nowMs: 400,
                })
            )()
        ).toBe(false);
        expect(
            db
                .query(
                    `SELECT lifecycle, cdb_state, run_token, run_target_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(old.registrationId)
        ).toEqual({ lifecycle: "retiring", cdb_state: "retiring", run_token: null, run_target_version: null });
        expect(
            db.query("SELECT registration_id FROM _gw_registration_heads WHERE principal_id = ?").get(old.principalId)
        ).toEqual({ registration_id: replacement.registrationId });
    });

    test("lists and retires only exact current generations for one connection", () => {
        const first = registration("registration-connection-a1", "principal-1", {
            connectionId: "connection-a",
            subId: SubId(1),
            shardId: "logical-a1",
            sourceCdbId: "physical-a1",
        });
        const second = registration("registration-connection-a2", "principal-1", {
            connectionId: "connection-a",
            subId: SubId(2),
            shardId: "logical-a2",
            sourceCdbId: "physical-a2",
        });
        const other = registration("registration-connection-b", "principal-1", {
            connectionId: "connection-b",
            subId: SubId(3),
            shardId: "logical-b",
            sourceCdbId: "physical-b",
        });
        db.transaction(() => {
            installGatewayRegistration(sql, first);
            installGatewayRegistration(sql, second);
            installGatewayRegistration(sql, other);
        })();

        expect(listCurrentGatewayRegistrationsForConnection(sql, "connection-a")).toEqual([
            {
                principalId: PrincipalId("principal-1"),
                clientId: ClientId("client-shared"),
                subId: SubId(1),
                registrationId: "registration-connection-a1",
                connectionId: "connection-a",
                shardId: "logical-a1",
                sourceCdbId: "physical-a1",
            },
            {
                principalId: PrincipalId("principal-1"),
                clientId: ClientId("client-shared"),
                subId: SubId(2),
                registrationId: "registration-connection-a2",
                connectionId: "connection-a",
                shardId: "logical-a2",
                sourceCdbId: "physical-a2",
            },
        ]);
        expect(
            db.transaction(() =>
                retireCurrentGatewayRegistration(sql, { ...first, connectionId: "wrong-connection", nowMs: 200 })
            )()
        ).toBeNull();
        expect(
            db.transaction(() => retireCurrentGatewayRegistrationsForConnection(sql, "connection-a", 300))()
        ).toHaveLength(2);
        expect(db.query("SELECT registration_id FROM _gw_registration_heads ORDER BY registration_id").all()).toEqual([
            { registration_id: other.registrationId },
        ]);
        expect(
            db
                .query(
                    `SELECT registration_id, lifecycle, cdb_state, run_version
                     FROM _gw_registration_generations ORDER BY registration_id`
                )
                .all()
        ).toEqual([
            {
                registration_id: first.registrationId,
                lifecycle: "retiring",
                cdb_state: "retiring",
                run_version: 1,
            },
            {
                registration_id: second.registrationId,
                lifecycle: "retiring",
                cdb_state: "retiring",
                run_version: 1,
            },
            {
                registration_id: other.registrationId,
                lifecycle: "installing",
                cdb_state: "pending",
                run_version: 0,
            },
        ]);
    });

    test("fails closed for corrupt head identity and impossible generation state", () => {
        const corruptHead = registration("registration-corrupt-head");
        db.transaction(() => installGatewayRegistration(sql, corruptHead))();
        db.query("UPDATE _gw_registration_heads SET principal_id = 'corrupt-principal' WHERE registration_id = ?").run(
            corruptHead.registrationId
        );

        expect(
            db.transaction(() => beginInitialGatewayQuery(sql, { ...corruptHead, changeSeq: 1, nowMs: 200 }))()
        ).toBeNull();
        expect(listCurrentGatewayRegistrationsForConnection(sql, corruptHead.connectionId)).toEqual([]);
        expect(
            db.transaction(() => retireCurrentGatewayRegistration(sql, { ...corruptHead, nowMs: 300 }))()
        ).toBeNull();

        const corruptGeneration = registration("registration-corrupt-generation", "principal-2", {
            clientId: ClientId("client-2"),
        });
        db.transaction(() => installGatewayRegistration(sql, corruptGeneration))();
        db.query("UPDATE _gw_registration_generations SET lifecycle = 'active' WHERE registration_id = ?").run(
            corruptGeneration.registrationId
        );
        expect(
            db.transaction(() => beginInitialGatewayQuery(sql, { ...corruptGeneration, changeSeq: 1, nowMs: 200 }))()
        ).toBeNull();
    });

    test("retires active generations created before policy identity existed", () => {
        const legacy = new Database(":memory:");
        try {
            legacy.exec(`
                CREATE TABLE _gw_registration_generations (
                  registration_id TEXT PRIMARY KEY,
                  source_cdb_id TEXT,
                  lifecycle TEXT NOT NULL,
                  cdb_state TEXT NOT NULL,
                  run_token TEXT,
                  run_target_version INTEGER,
                  run_lease_expires_at INTEGER,
                  run_version INTEGER NOT NULL,
                  last_snapshot_cookie TEXT,
                  initial_snapshot_pending INTEGER NOT NULL,
                  retry_count INTEGER NOT NULL,
                  retry_at INTEGER,
                  retry_error TEXT,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE _gw_registration_heads (registration_id TEXT PRIMARY KEY);
                CREATE TABLE _gw_snapshot_outbox (registration_id TEXT PRIMARY KEY);
                INSERT INTO _gw_registration_generations VALUES (
                  'registration-legacy', 'cdb-legacy', 'active', 'active',
                  'run-legacy', 2, 500, 3, 'cookie-legacy', 0, 4, 600, 'old error', 100
                );
                INSERT INTO _gw_registration_heads VALUES ('registration-legacy');
                INSERT INTO _gw_snapshot_outbox VALUES ('registration-legacy');
            `);
            const legacySql = syncSql(legacy);

            ensureGatewayRegistrationColumns(legacySql);

            expect(
                (legacy.query("PRAGMA table_info('_gw_registration_generations')").all() as { name: string }[]).map(
                    column => column.name
                )
            ).toContain("policy_digest");
            expect(
                legacy
                    .query(
                        `SELECT lifecycle, cdb_state, run_token, run_target_version, run_lease_expires_at,
                                run_version, retry_count, retry_at, retry_error, policy_digest
                         FROM _gw_registration_generations`
                    )
                    .get()
            ).toEqual({
                lifecycle: "retiring",
                cdb_state: "retiring",
                run_token: null,
                run_target_version: null,
                run_lease_expires_at: null,
                run_version: 4,
                retry_count: 0,
                retry_at: 100,
                retry_error: null,
                policy_digest: null,
            });
            expect(legacy.query("SELECT * FROM _gw_registration_heads").all()).toEqual([]);
            expect(legacy.query("SELECT * FROM _gw_snapshot_outbox").all()).toEqual([]);
        } finally {
            legacy.close();
        }
    });
});
