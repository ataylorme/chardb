import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    GATEWAY_MAX_DURABLE_PAYLOAD_BYTES,
    GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES,
    GATEWAY_REGISTRATION_DDL,
    type GatewayDirtyRun,
    type GatewayRegistrationInstall,
    claimDirtyGatewayRegistration,
    claimDueGatewaySnapshot,
    cleanupGatewayRegistration,
    ensureGatewayRegistrationColumns,
    failGatewayDirtyRun,
    failGatewaySnapshotSend,
    gatewayDurablePayloadUsage,
    installGatewayRegistration,
    retireGatewayRegistration,
    stageGatewaySnapshot,
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
    overrides: Partial<GatewayRegistrationInstall> = {}
): GatewayRegistrationInstall {
    return {
        registrationId,
        principalId: PrincipalId("principal-1"),
        clientId: ClientId("client-1"),
        subId: SubId(1),
        connectionId: `connection-${registrationId}`,
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        policyDigest: "policy-digest-1",
        queryHash: "query-hash-1",
        shardId: "logical-shard-1",
        sourceCdbId: "physical-cdb-1",
        schemaEpoch: 1,
        domainSchemaEpoch: 1,
        authEpochs: { global: 1, tenant: 2, principal: 3 },
        nowMs: 100,
        ...overrides,
    };
}

function jsonStringOfByteLength(byteLength: number): string {
    const empty = '{"padding":""}';
    if (byteLength < empty.length) throw new Error("requested JSON payload is too small");
    return `{"padding":"${"x".repeat(byteLength - empty.length)}"}`;
}

function fillRegistrationUsage(db: Database, sql: SyncSql, registrationId: string, targetBytes: number): void {
    const current = gatewayDurablePayloadUsage(sql).chargedRegistrationBytes;
    const row = db
        .query("SELECT query_hash FROM _gw_registration_generations WHERE registration_id = ?")
        .get(registrationId) as { query_hash: string };
    const currentHashBytes = new TextEncoder().encode(row.query_hash).byteLength;
    const desiredHashBytes = currentHashBytes + targetBytes - current;
    db.query("UPDATE _gw_registration_generations SET query_hash = ? WHERE registration_id = ?").run(
        "x".repeat(desiredHashBytes),
        registrationId
    );
    expect(gatewayDurablePayloadUsage(sql).chargedRegistrationBytes).toBe(targetBytes);
}

function fillTotalUsageWithSnapshot(db: Database, sql: SyncSql, registrationId: string, targetBytes: number): void {
    const current = gatewayDurablePayloadUsage(sql).chargedTotalBytes;
    const row = db.query("SELECT rows_json FROM _gw_snapshot_outbox WHERE registration_id = ?").get(registrationId) as {
        rows_json: string;
    };
    const currentRowsBytes = new TextEncoder().encode(row.rows_json).byteLength;
    const desiredRowsBytes = currentRowsBytes + targetBytes - current;
    const empty = '[""]';
    db.query("UPDATE _gw_snapshot_outbox SET rows_json = ? WHERE registration_id = ?").run(
        `["${"x".repeat(desiredRowsBytes - empty.length)}"]`,
        registrationId
    );
    expect(gatewayDurablePayloadUsage(sql).chargedTotalBytes).toBe(targetBytes);
}

function expectRateLimited(run: () => unknown): void {
    try {
        run();
        throw new Error("expected Gateway quota rejection");
    } catch (error) {
        expect(error).toBeInstanceOf(CdbError);
        expect(error).toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
    }
}

function activateRegistration(db: Database, input: GatewayRegistrationInstall): void {
    const result = db
        .query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', initial_snapshot_pending = 1,
                 retry_count = 0, retry_at = NULL, retry_error = NULL, updated_at = ?
             WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
               AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'pending'`
        )
        .run(input.nowMs, input.registrationId, input.principalId, input.clientId, input.subId, input.connectionId);
    expect(result.changes).toBe(1);
}

describe("Gateway durable payload budget", () => {
    let db: Database;
    let sql: SyncSql;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(GATEWAY_REGISTRATION_DDL);
        sql = syncSql(db);
    });

    afterEach(() => db.close());

    test("accepts the registration ceiling, rejects the next logical head, and compacts a replacement", () => {
        const current = registration("registration-current");
        db.transaction(() => installGatewayRegistration(sql, current))();
        fillRegistrationUsage(db, sql, current.registrationId, GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);

        const overflow = registration("registration-overflow", {
            principalId: PrincipalId("principal-2"),
            clientId: ClientId("client-2"),
            subId: SubId(2),
        });
        expectRateLimited(() => db.transaction(() => installGatewayRegistration(sql, overflow))());
        expect(
            db
                .query("SELECT registration_id FROM _gw_registration_heads WHERE registration_id = ?")
                .get(overflow.registrationId)
        ).toBeNull();
        expect(
            db
                .query("SELECT registration_id FROM _gw_registration_generations WHERE registration_id = ?")
                .get(overflow.registrationId)
        ).toBeNull();

        db.query(
            `INSERT INTO _gw_snapshot_outbox
             (registration_id, cookie, target_version, rows_json, byte_size,
              send_attempts, next_attempt_at, claim_token, claim_version, claim_expires_at,
              attachment_base_cookie, last_sent_at, last_error, created_at)
             VALUES (?, 'current-cookie', 0, '[]', 0, 0, 100, NULL, 0, NULL, NULL, NULL, NULL, 100)`
        ).run(current.registrationId);
        const rejectedReplacement = registration("registration-rejected-replacement", {
            args: { padding: "x".repeat(GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES) },
            nowMs: 150,
        });
        expectRateLimited(() => db.transaction(() => installGatewayRegistration(sql, rejectedReplacement))());
        expect(db.query("SELECT registration_id FROM _gw_registration_heads").get()).toEqual({
            registration_id: current.registrationId,
        });
        expect(
            db
                .query(
                    "SELECT lifecycle, length(CAST(args_json AS BLOB)) AS args_bytes FROM _gw_registration_generations"
                )
                .get()
        ).toMatchObject({ lifecycle: "installing" });
        expect(db.query("SELECT registration_id FROM _gw_snapshot_outbox").get()).toEqual({
            registration_id: current.registrationId,
        });

        const replacement = registration("registration-replacement", { nowMs: 200 });
        expect(db.transaction(() => installGatewayRegistration(sql, replacement))()).toEqual({
            supersededRegistrationId: current.registrationId,
        });
        expect(
            db
                .query(
                    `SELECT lifecycle, organization_id, ref, args_json, intent_json, policy_digest,
                            query_hash, shard_id, source_cdb_id, connection_id
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            lifecycle: "retiring",
            organization_id: "",
            ref: "",
            args_json: "null",
            intent_json: "null",
            policy_digest: "",
            query_hash: "",
            shard_id: "",
            source_cdb_id: "physical-cdb-1",
            connection_id: "connection-registration-current",
        });
        expect(gatewayDurablePayloadUsage(sql).registrationBytes).toBeLessThan(GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);
    });

    test("counts UTF-8 bytes and ignores a corrupt staged byte_size while rolling staging back", () => {
        const first = registration("registration-first");
        const second = registration("registration-second", {
            principalId: PrincipalId("principal-2"),
            clientId: ClientId("client-2"),
            subId: SubId(2),
            connectionId: "connection-second",
        });
        db.transaction(() => {
            installGatewayRegistration(sql, first);
            installGatewayRegistration(sql, second);
        })();
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = 1,
                 delivered_version = 0, initial_snapshot_pending = 1, retry_at = NULL`
        ).run();

        db.query("UPDATE _gw_registration_generations SET args_json = ? WHERE registration_id = ?").run(
            '{"label":"é"}',
            first.registrationId
        );
        const multibyteUsage = gatewayDurablePayloadUsage(sql).registrationBytes;
        db.query("UPDATE _gw_registration_generations SET args_json = ? WHERE registration_id = ?").run(
            '{"label":"e"}',
            first.registrationId
        );
        expect(multibyteUsage - gatewayDurablePayloadUsage(sql).registrationBytes).toBe(1);

        const run = db.transaction(() =>
            claimDirtyGatewayRegistration(sql, {
                principalId: second.principalId,
                clientId: second.clientId,
                subId: second.subId,
                registrationId: second.registrationId,
                connectionId: second.connectionId,
                nowMs: 200,
                leaseExpiresAt: 300,
            })
        )() as GatewayDirtyRun;
        fillRegistrationUsage(db, sql, first.registrationId, GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);
        const legacyRows = jsonStringOfByteLength(600 * 1024);
        db.query(
            `INSERT INTO _gw_snapshot_outbox
             (registration_id, cookie, target_version, rows_json, byte_size,
              send_attempts, next_attempt_at, claim_token, claim_version, claim_expires_at,
              attachment_base_cookie, last_sent_at, last_error, created_at)
             VALUES (?, 'legacy-cookie', 1, ?, 0, 0, 200, NULL, 0, NULL, NULL, NULL, NULL, 100)`
        ).run(first.registrationId, legacyRows);
        expect(gatewayDurablePayloadUsage(sql).snapshotBytes).toBeGreaterThan(600 * 1024);

        const before = db
            .query(
                `SELECT run_token, run_target_version, run_lease_expires_at, run_version
                 FROM _gw_registration_generations WHERE registration_id = ?`
            )
            .get(second.registrationId);
        const stage = () =>
            db.transaction(() =>
                stageGatewaySnapshot(sql, {
                    principalId: second.principalId,
                    clientId: second.clientId,
                    subId: second.subId,
                    registrationId: second.registrationId,
                    connectionId: second.connectionId,
                    runToken: run.runToken,
                    runVersion: run.runVersion,
                    targetVersion: run.targetVersion,
                    cookie: Cookie("second-cookie"),
                    rows: [{ payload: "x".repeat(500 * 1024) }],
                    authEpochs: { global: 4, tenant: 5, principal: 6 },
                    nowMs: 220,
                })
            )();
        expectRateLimited(stage);
        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at, run_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(second.registrationId)
        ).toEqual(before);
        expect(
            db
                .query("SELECT registration_id FROM _gw_snapshot_outbox WHERE registration_id = ?")
                .get(second.registrationId)
        ).toBeNull();

        db.query("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?").run(first.registrationId);
        expect(stage()).toBe(true);
        expect(gatewayDurablePayloadUsage(sql).totalBytes).toBeLessThanOrEqual(GATEWAY_MAX_DURABLE_PAYLOAD_BYTES);
    });

    test("bootstrap scrubs legacy retired payload and outbox without losing cleanup identity", () => {
        const legacy = registration("registration-legacy");
        db.transaction(() => installGatewayRegistration(sql, legacy))();
        db.query("DELETE FROM _gw_registration_heads WHERE registration_id = ?").run(legacy.registrationId);
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'retiring', cdb_state = 'retiring', args_json = ?, intent_json = ?, ref = ?
             WHERE registration_id = ?`
        ).run(jsonStringOfByteLength(200_000), jsonStringOfByteLength(200_000), "legacy-ref", legacy.registrationId);
        db.query(
            `INSERT INTO _gw_snapshot_outbox
             (registration_id, cookie, target_version, rows_json, byte_size,
              send_attempts, next_attempt_at, claim_token, claim_version, claim_expires_at,
              attachment_base_cookie, last_sent_at, last_error, created_at)
             VALUES (?, 'legacy-cookie', 1, '[1]', 1, 0, 100, NULL, 0, NULL, NULL, NULL, NULL, 100)`
        ).run(legacy.registrationId);

        ensureGatewayRegistrationColumns(sql);

        expect(
            db
                .query(
                    `SELECT args_json, intent_json, ref, source_cdb_id, connection_id
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(legacy.registrationId)
        ).toEqual({
            args_json: "null",
            intent_json: "null",
            ref: "",
            source_cdb_id: "physical-cdb-1",
            connection_id: "connection-registration-legacy",
        });
        expect(db.query("SELECT registration_id FROM _gw_snapshot_outbox").get()).toBeNull();
    });

    test("pre-reserved generation metadata keeps exact-bound run claims and retry errors within quota", () => {
        const current = registration("registration-run-metadata");
        db.transaction(() => installGatewayRegistration(sql, current))();
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = 1, delivered_version = 0,
                 retry_at = NULL, retry_error = NULL
             WHERE registration_id = ?`
        ).run(current.registrationId);
        fillRegistrationUsage(db, sql, current.registrationId, GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);
        const rawBeforeClaim = gatewayDurablePayloadUsage(sql).totalBytes;

        const run = db.transaction(() =>
            claimDirtyGatewayRegistration(sql, {
                principalId: current.principalId,
                clientId: current.clientId,
                subId: current.subId,
                registrationId: current.registrationId,
                connectionId: current.connectionId,
                nowMs: 200,
                leaseExpiresAt: 300,
            })
        )() as GatewayDirtyRun;
        const afterClaim = gatewayDurablePayloadUsage(sql);
        expect(afterClaim.totalBytes - rawBeforeClaim).toBe(36);
        expect(afterClaim.chargedRegistrationBytes).toBe(GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);

        expect(
            db.transaction(() =>
                failGatewayDirtyRun(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    subId: current.subId,
                    registrationId: current.registrationId,
                    connectionId: current.connectionId,
                    runToken: run.runToken,
                    runVersion: run.runVersion,
                    nowMs: 220,
                    error: "é".repeat(512),
                })
            )()
        ).toBe(true);
        const afterFailure = gatewayDurablePayloadUsage(sql);
        expect(afterFailure.chargedRegistrationBytes).toBe(GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);
        expect(afterFailure.totalBytes).toBeLessThanOrEqual(GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);
    });

    test("pre-reserved outbox metadata keeps exact-bound claims and send errors within quota", () => {
        const current = registration("registration-send-metadata");
        db.transaction(() => installGatewayRegistration(sql, current))();
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = 1, delivered_version = 0,
                 retry_at = NULL, retry_error = NULL
             WHERE registration_id = ?`
        ).run(current.registrationId);
        const run = db.transaction(() =>
            claimDirtyGatewayRegistration(sql, {
                principalId: current.principalId,
                clientId: current.clientId,
                subId: current.subId,
                registrationId: current.registrationId,
                connectionId: current.connectionId,
                nowMs: 200,
                leaseExpiresAt: 300,
            })
        )() as GatewayDirtyRun;
        expect(
            db.transaction(() =>
                stageGatewaySnapshot(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    subId: current.subId,
                    registrationId: current.registrationId,
                    connectionId: current.connectionId,
                    runToken: run.runToken,
                    runVersion: run.runVersion,
                    targetVersion: run.targetVersion,
                    cookie: Cookie("snapshot-metadata-cookie"),
                    rows: [],
                    authEpochs: current.authEpochs,
                    nowMs: 220,
                })
            )()
        ).toBe(true);
        fillTotalUsageWithSnapshot(db, sql, current.registrationId, GATEWAY_MAX_DURABLE_PAYLOAD_BYTES);
        const rawBeforeClaim = gatewayDurablePayloadUsage(sql).totalBytes;

        const attempt = db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 }))();
        expect(attempt).not.toBeNull();
        const afterClaim = gatewayDurablePayloadUsage(sql);
        expect(afterClaim.totalBytes - rawBeforeClaim).toBe(36);
        expect(afterClaim.chargedTotalBytes).toBe(GATEWAY_MAX_DURABLE_PAYLOAD_BYTES);

        expect(
            db.transaction(() =>
                failGatewaySnapshotSend(sql, {
                    registrationId: current.registrationId,
                    cookie: Cookie("snapshot-metadata-cookie"),
                    claimToken: attempt?.claimToken as string,
                    claimVersion: attempt?.claimVersion as number,
                    nowMs: 230,
                    error: "é".repeat(512),
                })
            )()
        ).toBe(true);
        const afterFailure = gatewayDurablePayloadUsage(sql);
        expect(afterFailure.chargedTotalBytes).toBe(GATEWAY_MAX_DURABLE_PAYLOAD_BYTES);
        expect(afterFailure.totalBytes).toBeLessThanOrEqual(GATEWAY_MAX_DURABLE_PAYLOAD_BYTES);
    });

    test("cleanup releases bytes retained by exact unsubscribe identity", () => {
        const retired = registration("registration-retired");
        db.transaction(() => installGatewayRegistration(sql, retired))();
        activateRegistration(db, retired);
        expect(db.transaction(() => retireGatewayRegistration(sql, retired, retired.registrationId, 200))()).toBe(true);
        fillRegistrationUsage(db, sql, retired.registrationId, GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES);

        const next = registration("registration-next", {
            principalId: PrincipalId("principal-next"),
            clientId: ClientId("client-next"),
            subId: SubId(2),
        });
        expectRateLimited(() => db.transaction(() => installGatewayRegistration(sql, next))());
        expect(db.transaction(() => cleanupGatewayRegistration(sql, retired, retired.registrationId))()).toBe(true);
        expect(db.transaction(() => installGatewayRegistration(sql, next))()).toEqual({
            supersededRegistrationId: null,
        });
    });
});
