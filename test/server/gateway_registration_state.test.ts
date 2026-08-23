import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    GATEWAY_REGISTRATION_DDL,
    type GatewayRegistrationAdvance,
    type GatewayRegistrationInstall,
    advanceGatewayRegistration,
    cleanupGatewayRegistration,
    installGatewayRegistration,
    retireGatewayRegistration,
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
        runToken: `run-${input.registrationId}`,
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
        ).not.toContain("policy_digest");
        expect(
            db
                .query(
                    `SELECT connection_id, organization_id, ref, args_json, intent_json, query_hash, shard_id,
                            source_cdb_id,
                            schema_epoch, auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
                            lifecycle, cdb_state, dirty_version, delivered_version, run_token, run_version,
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
                    "SELECT lifecycle, cdb_state, run_token, run_version FROM _gw_registration_generations WHERE registration_id = ?"
                )
                .get(first.registrationId)
        ).toEqual({ lifecycle: "retiring", cdb_state: "retiring", run_token: null, run_version: 2 });
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
            run_token: "run-registration-2",
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

        expect(db.transaction(() => retireGatewayRegistration(sql, current, current.registrationId, 250))()).toBe(true);
        expect(db.query("SELECT * FROM _gw_registration_heads").all()).toEqual([]);
        expect(
            db
                .query(
                    "SELECT lifecycle, cdb_state, run_version FROM _gw_registration_generations WHERE registration_id = ?"
                )
                .get(current.registrationId)
        ).toEqual({ lifecycle: "retiring", cdb_state: "retiring", run_version: 1 });
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
});
