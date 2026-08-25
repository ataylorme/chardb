import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    GATEWAY_MAX_SNAPSHOT_REPLAY_ROWS,
    GATEWAY_REGISTRATION_DDL,
    Gateway,
    type GatewayDirtyRun,
    type GatewayEnv,
    type GatewayRegistrationInstall,
    type GatewaySnapshotSendAttempt,
    acknowledgeGatewaySnapshot,
    acknowledgeGatewaySnapshotReplay,
    claimDirtyGatewayRegistration,
    claimDueGatewaySnapshot,
    failGatewaySnapshotSend,
    installGatewayRegistration,
    pruneGatewaySnapshotReplays,
    resolveGatewaySnapshotReplay,
    retainCurrentGatewaySnapshotReplay,
    retireClaimedGatewaySnapshot,
    retireGatewayRegistration,
    stageGatewaySnapshot,
} from "../../src/server/do/gateway.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, SubId, TenantId } from "../../src/types.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

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

describe("Gateway snapshot delivery state", () => {
    let db: Database;
    let sql: SyncSql;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(GATEWAY_REGISTRATION_DDL);
        sql = syncSql(db);
    });

    afterEach(() => db.close());

    function installActive(input: GatewayRegistrationInstall, dirtyVersion = 5, deliveredVersion = 2): void {
        db.transaction(() => installGatewayRegistration(sql, input))();
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = ?, delivered_version = ?,
                 retry_count = 4, retry_at = 150, retry_error = 'query failed'
             WHERE registration_id = ?`
        ).run(dirtyVersion, deliveredVersion, input.registrationId);
    }

    function claim(input: GatewayRegistrationInstall, nowMs = 200, leaseExpiresAt = 300): GatewayDirtyRun | null {
        return db.transaction(() =>
            claimDirtyGatewayRegistration(sql, {
                principalId: input.principalId,
                clientId: input.clientId,
                subId: input.subId,
                registrationId: input.registrationId,
                connectionId: input.connectionId,
                nowMs,
                leaseExpiresAt,
            })
        )();
    }

    function stage(
        input: GatewayRegistrationInstall,
        run: GatewayDirtyRun,
        overrides: Partial<Parameters<typeof stageGatewaySnapshot>[1]> = {}
    ): boolean {
        return db.transaction(() =>
            stageGatewaySnapshot(sql, {
                principalId: input.principalId,
                clientId: input.clientId,
                subId: input.subId,
                registrationId: input.registrationId,
                connectionId: input.connectionId,
                runToken: run.runToken,
                runVersion: run.runVersion,
                targetVersion: run.targetVersion,
                cookie: Cookie(`cookie-${input.registrationId}`),
                rows: [{ id: 1, body: "héllo" }],
                authEpochs: { global: 10, tenant: 11, principal: 12 },
                nowMs: 220,
                ...overrides,
            })
        )();
    }

    async function bootstrapGateway(): Promise<void> {
        let ready: Promise<unknown> = Promise.resolve();
        const state = {
            id: { toString: () => "gateway-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async (): Promise<number | null> => null,
                setAlarm: async (): Promise<void> => {},
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        void new Gateway(state, {} as GatewayEnv);
        await ready;
    }

    test("stages the claimed target without claiming delivery or losing newer dirtiness", () => {
        const current = registration("registration-stage");
        installActive(current);
        const run = claim(current);
        expect(run).toMatchObject({ targetVersion: 5, runVersion: 1, leaseExpiresAt: 300, reclaimed: false });
        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at, run_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            run_token: run?.runToken,
            run_target_version: 5,
            run_lease_expires_at: 300,
            run_version: 1,
        });

        db.query("UPDATE _gw_registration_generations SET dirty_version = 8 WHERE registration_id = ?").run(
            current.registrationId
        );
        expect(stage(current, run as GatewayDirtyRun, { runVersion: 0 })).toBe(false);
        expect(stage(current, run as GatewayDirtyRun)).toBe(true);

        expect(
            db
                .query(
                    `SELECT dirty_version, delivered_version, run_token, run_target_version, run_lease_expires_at,
                            run_version, last_cookie, auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
                            retry_count, retry_at, retry_error
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            dirty_version: 8,
            delivered_version: 2,
            run_token: null,
            run_target_version: null,
            run_lease_expires_at: null,
            run_version: 2,
            last_cookie: null,
            auth_global_epoch: 10,
            auth_tenant_epoch: 11,
            auth_principal_epoch: 12,
            retry_count: 0,
            retry_at: null,
            retry_error: null,
        });
        const rowsJson = '[{"body":"héllo","id":1}]';
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toMatchObject({
            registration_id: current.registrationId,
            cookie: "cookie-registration-stage",
            target_version: 5,
            rows_json: rowsJson,
            byte_size: new TextEncoder().encode(rowsJson).byteLength,
            send_attempts: 0,
            next_attempt_at: 220,
            last_sent_at: null,
            last_error: null,
            created_at: 220,
        });
        expect(claim(current, 230, 330)).toBeNull();
    });

    test("reclaims an expired run and fences the old token and run version", () => {
        const current = registration("registration-reclaim");
        installActive(current);
        const first = claim(current, 200, 250) as GatewayDirtyRun;
        db.query("UPDATE _gw_registration_generations SET dirty_version = 7 WHERE registration_id = ?").run(
            current.registrationId
        );

        expect(claim(current, 249, 350)).toBeNull();
        const reclaimed = claim(current, 250, 350) as GatewayDirtyRun;
        expect(reclaimed).toMatchObject({ targetVersion: 7, runVersion: 2, leaseExpiresAt: 350, reclaimed: true });
        expect(reclaimed.runToken).not.toBe(first.runToken);
        expect(stage(current, first, { nowMs: 260 })).toBe(false);
        expect(stage(current, reclaimed, { nowMs: 260 })).toBe(true);
    });

    test("does not claim a dirty generation before its query retry is due", () => {
        const current = registration("registration-backoff");
        installActive(current);

        expect(claim(current, 149, 249)).toBeNull();
        expect(claim(current, 150, 250)).toMatchObject({ targetVersion: 5, reclaimed: false });
    });

    test("claims only due staged snapshots and records each durable send attempt", () => {
        const current = registration("registration-send");
        installActive(current);
        expect(stage(current, claim(current) as GatewayDirtyRun)).toBe(true);

        expect(db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 219, attemptExpiresAt: 300 }))()).toBeNull();
        const firstAttempt = db.transaction(() =>
            claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 })
        )();
        expect(firstAttempt).toMatchObject({
            principalId: current.principalId,
            clientId: current.clientId,
            subId: current.subId,
            registrationId: current.registrationId,
            connectionId: current.connectionId,
            cookie: Cookie("cookie-registration-send"),
            targetVersion: 5,
            rows: [{ body: "héllo", id: 1 }],
            byteSize: new TextEncoder().encode('[{"body":"héllo","id":1}]').byteLength,
            sendAttempts: 1,
            nextAttemptAt: 300,
            claimVersion: 1,
        });
        expect(firstAttempt?.claimToken).toEqual(expect.any(String));
        expect(db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 299, attemptExpiresAt: 400 }))()).toBeNull();
        expect(
            db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 300, attemptExpiresAt: 400 }))()
        ).toMatchObject({ sendAttempts: 2, nextAttemptAt: 400 });
        expect(db.query("SELECT send_attempts, next_attempt_at, last_sent_at FROM _gw_snapshot_outbox").get()).toEqual({
            send_attempts: 2,
            next_attempt_at: 400,
            last_sent_at: 300,
        });
    });

    test("fences a stale send claimant after lease recovery and after acknowledgement", () => {
        const current = registration("registration-send-fence");
        installActive(current);
        expect(stage(current, claim(current) as GatewayDirtyRun)).toBe(true);
        const first = db.transaction(() =>
            claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 })
        )() as GatewaySnapshotSendAttempt;
        const second = db.transaction(() =>
            claimDueGatewaySnapshot(sql, { nowMs: 300, attemptExpiresAt: 400 })
        )() as GatewaySnapshotSendAttempt;

        expect(
            db.transaction(() =>
                failGatewaySnapshotSend(sql, {
                    registrationId: first.registrationId,
                    cookie: first.cookie,
                    claimToken: first.claimToken,
                    claimVersion: first.claimVersion,
                    nowMs: 301,
                    error: "late first attempt",
                })
            )()
        ).toBe(false);
        expect(
            db.transaction(() =>
                retireClaimedGatewaySnapshot(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    subId: current.subId,
                    registrationId: current.registrationId,
                    connectionId: current.connectionId,
                    cookie: first.cookie,
                    claimToken: first.claimToken,
                    claimVersion: first.claimVersion,
                    nowMs: 301,
                })
            )()
        ).toBe(false);
        expect(
            db
                .query(
                    `SELECT claim_token, claim_version, last_error
                 FROM _gw_snapshot_outbox WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({ claim_token: second.claimToken, claim_version: second.claimVersion, last_error: null });
        expect(db.query("SELECT registration_id FROM _gw_registration_heads").get()).toEqual({
            registration_id: current.registrationId,
        });

        expect(
            db.transaction(() =>
                acknowledgeGatewaySnapshot(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    subId: current.subId,
                    registrationId: current.registrationId,
                    connectionId: current.connectionId,
                    cookie: second.cookie,
                    nowMs: 302,
                })
            )()
        ).toBe(true);
        expect(
            db.transaction(() =>
                failGatewaySnapshotSend(sql, {
                    registrationId: second.registrationId,
                    cookie: second.cookie,
                    claimToken: second.claimToken,
                    claimVersion: second.claimVersion,
                    nowMs: 303,
                    error: "late second attempt",
                })
            )()
        ).toBe(false);
    });

    test("rolls back a send claim when staged rows are corrupt", () => {
        const current = registration("registration-corrupt-send");
        installActive(current);
        expect(stage(current, claim(current) as GatewayDirtyRun)).toBe(true);
        db.query("UPDATE _gw_snapshot_outbox SET rows_json = 'not-json' WHERE registration_id = ?").run(
            current.registrationId
        );

        expect(() =>
            db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 }))()
        ).toThrow("staged Gateway snapshot rows are not valid JSON");
        expect(
            db
                .query(
                    `SELECT send_attempts, next_attempt_at, last_sent_at
                     FROM _gw_snapshot_outbox WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({ send_attempts: 0, next_attempt_at: 220, last_sent_at: null });
    });

    test("rolls back generation state when a staged cookie is not unique", () => {
        const first = registration("registration-cookie-first", { subId: SubId(1) });
        installActive(first);
        const sharedCookie = Cookie("cookie-shared");
        expect(stage(first, claim(first) as GatewayDirtyRun, { cookie: sharedCookie })).toBe(true);

        const second = registration("registration-cookie-second", { subId: SubId(2) });
        installActive(second);
        const secondRun = claim(second) as GatewayDirtyRun;
        expect(() => stage(second, secondRun, { cookie: sharedCookie })).toThrow();
        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at, run_version,
                            retry_count, retry_at, retry_error
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(second.registrationId)
        ).toEqual({
            run_token: secondRun.runToken,
            run_target_version: secondRun.targetVersion,
            run_lease_expires_at: secondRun.leaseExpiresAt,
            run_version: secondRun.runVersion,
            retry_count: 4,
            retry_at: 150,
            retry_error: "query failed",
        });
        expect(
            db.query("SELECT * FROM _gw_snapshot_outbox WHERE registration_id = ?").get(second.registrationId)
        ).toBeNull();
    });

    test("acknowledges an exact staged cookie only to its target while newer dirtiness remains", () => {
        const current = registration("registration-ack");
        installActive(current);
        expect(stage(current, claim(current) as GatewayDirtyRun)).toBe(true);
        db.query("UPDATE _gw_registration_generations SET dirty_version = 9 WHERE registration_id = ?").run(
            current.registrationId
        );
        const acknowledgement = {
            principalId: current.principalId,
            clientId: current.clientId,
            subId: current.subId,
            registrationId: current.registrationId,
            connectionId: current.connectionId,
            cookie: Cookie("cookie-registration-ack"),
            nowMs: 250,
        };

        expect(db.transaction(() => acknowledgeGatewaySnapshot(sql, acknowledgement))()).toBe(false);
        expect(
            db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 }))()
        ).not.toBeNull();
        expect(
            db.transaction(() =>
                acknowledgeGatewaySnapshot(sql, { ...acknowledgement, connectionId: "connection-wrong" })
            )()
        ).toBe(false);
        expect(db.transaction(() => acknowledgeGatewaySnapshot(sql, acknowledgement))()).toBe(true);
        expect(
            db
                .query(
                    `SELECT dirty_version, delivered_version, last_cookie, last_snapshot_cookie
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({
            dirty_version: 9,
            delivered_version: 5,
            last_cookie: "cookie-registration-ack",
            last_snapshot_cookie: "cookie-registration-ack",
        });
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();
        expect(db.transaction(() => acknowledgeGatewaySnapshot(sql, acknowledgement))()).toBe(true);
        expect(claim(current, 260, 360)).toMatchObject({ targetVersion: 9 });
    });

    test("does not treat an install or resume cookie as a duplicate snapshot acknowledgement", () => {
        const current = registration("registration-resume-cookie", { lastCookie: Cookie("cookie-resume") });
        installActive(current);

        expect(
            db.transaction(() =>
                acknowledgeGatewaySnapshot(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    subId: current.subId,
                    registrationId: current.registrationId,
                    connectionId: current.connectionId,
                    cookie: Cookie("cookie-resume"),
                    nowMs: 200,
                })
            )()
        ).toBe(false);
    });

    test("retains, exactly matches, acknowledges, and expires a sent snapshot replay", () => {
        const current = registration("registration-replay", { lastCookie: Cookie("cookie-before-replay") });
        installActive(current);
        expect(stage(current, claim(current) as GatewayDirtyRun)).toBe(true);
        expect(
            db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 220, attemptExpiresAt: 300 }))()
        ).not.toBeNull();
        expect(db.transaction(() => retainCurrentGatewaySnapshotReplay(sql, current, 225))()).toBe(true);

        const lookup = {
            principalId: current.principalId,
            clientId: current.clientId,
            subId: current.subId,
            cookie: Cookie("cookie-registration-replay"),
            organizationId: current.organizationId,
            ref: current.ref,
            args: current.args,
            policyDigest: current.policyDigest,
            queryHash: current.queryHash,
            shardId: current.shardId,
            sourceCdbId: current.sourceCdbId,
            schemaEpoch: current.schemaEpoch,
            domainSchemaEpoch: current.domainSchemaEpoch,
            authEpochs: { global: 10, tenant: 11, principal: 12 },
            nowMs: 226,
        } as const;
        expect(db.transaction(() => resolveGatewaySnapshotReplay(sql, lookup))()).toEqual({
            subId: current.subId,
            cookie: lookup.cookie,
            rows: [{ body: "héllo", id: 1 }],
        });
        expect(
            db.transaction(() => resolveGatewaySnapshotReplay(sql, { ...lookup, policyDigest: "changed" }))()
        ).toBeNull();
        expect(
            db.transaction(() =>
                acknowledgeGatewaySnapshotReplay(sql, {
                    principalId: current.principalId,
                    clientId: current.clientId,
                    cookie: lookup.cookie,
                    nowMs: 227,
                })
            )()
        ).toBe(current.subId);
        expect(db.transaction(() => resolveGatewaySnapshotReplay(sql, lookup))()).toBeNull();

        expect(db.transaction(() => retainCurrentGatewaySnapshotReplay(sql, current, 228))()).toBe(true);
        db.query("UPDATE _gw_snapshot_replay SET rows_json = 'not-json'").run();
        expect(db.transaction(() => resolveGatewaySnapshotReplay(sql, { ...lookup, nowMs: 229 }))()).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_snapshot_replay").get()).toEqual({ count: 0 });

        expect(db.transaction(() => retainCurrentGatewaySnapshotReplay(sql, current, 230))()).toBe(true);
        expect(
            db.transaction(() =>
                resolveGatewaySnapshotReplay(sql, {
                    ...lookup,
                    nowMs: 220 + 30_000,
                })
            )()
        ).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_snapshot_replay").get()).toEqual({ count: 0 });
    });

    test("evicts the oldest replay identities at the hard global row bound", () => {
        const insert = db.query(
            `INSERT INTO _gw_snapshot_replay
             (principal_id, client_id, sub_id, cookie, organization_id, ref, args_json,
              policy_digest, query_hash, shard_id, source_cdb_id, schema_epoch, domain_schema_epoch,
              auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
              rows_json, byte_size, created_at, expires_at)
             VALUES (?, ?, 0, ?, 'org-1', 'queries.ts#messages', '{}',
                     'policy', 'query', 'shard', 'cdb', 1, 1, 1, 1, 1, '[]', 2, ?, ?)`
        );
        for (let index = 0; index <= GATEWAY_MAX_SNAPSHOT_REPLAY_ROWS; index++) {
            insert.run("principal-1", `client-${index}`, `cookie-${index}`, index, 100_000 + index);
        }

        expect(db.transaction(() => pruneGatewaySnapshotReplays(sql, 1))()).toBe(1);
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_snapshot_replay").get()).toEqual({
            count: GATEWAY_MAX_SNAPSHOT_REPLAY_ROWS,
        });
        expect(db.query("SELECT 1 FROM _gw_snapshot_replay WHERE client_id = 'client-0'").get()).toBeNull();
        expect(db.query("SELECT 1 FROM _gw_snapshot_replay WHERE client_id = 'client-256'").get()).not.toBeNull();
    });

    test("retirement and supersession clear leases and discard staged snapshots", () => {
        const running = registration("registration-running", { subId: SubId(1) });
        installActive(running);
        expect(claim(running)).not.toBeNull();
        expect(db.transaction(() => retireGatewayRegistration(sql, running, running.registrationId, 240))()).toBe(true);
        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(running.registrationId)
        ).toEqual({ run_token: null, run_target_version: null, run_lease_expires_at: null });

        const staged = registration("registration-staged", { subId: SubId(2) });
        installActive(staged);
        expect(stage(staged, claim(staged) as GatewayDirtyRun)).toBe(true);
        const replacement = registration("registration-replacement", { subId: SubId(2), nowMs: 300 });
        db.transaction(() => installGatewayRegistration(sql, replacement))();

        expect(
            db.query("SELECT * FROM _gw_snapshot_outbox WHERE registration_id = ?").get(staged.registrationId)
        ).toBeNull();
        expect(
            db
                .query(
                    `SELECT lifecycle, run_token, run_target_version, run_lease_expires_at
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(staged.registrationId)
        ).toEqual({
            lifecycle: "retiring",
            run_token: null,
            run_target_version: null,
            run_lease_expires_at: null,
        });
    });

    test("upgrades the 160eb45 outbox shape, claims after restart, and repairs a partial claim", async () => {
        db.close();
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        const legacyDdl = GATEWAY_REGISTRATION_DDL.replace("  claim_token TEXT,\n", "")
            .replace("  claim_version INTEGER NOT NULL DEFAULT 0 CHECK (claim_version >= 0),\n", "")
            .replace("  claim_expires_at INTEGER CHECK (claim_expires_at IS NULL OR claim_expires_at >= 0),\n", "")
            .replace("  attachment_base_cookie TEXT,\n", "");
        db.exec(legacyDdl);
        sql = syncSql(db);
        const current = registration("registration-legacy-outbox");
        installActive(current);
        db.query(
            `INSERT INTO _gw_snapshot_outbox
             (registration_id, cookie, target_version, rows_json, byte_size, send_attempts,
              next_attempt_at, last_sent_at, last_error, created_at)
             VALUES (?, 'cookie-legacy-outbox', 5, '[{"id":1}]', 10, 0, 200, NULL, NULL, 200)`
        ).run(current.registrationId);

        await bootstrapGateway();

        expect(
            (db.query("PRAGMA table_info('_gw_snapshot_outbox')").all() as { name: string }[]).map(row => row.name)
        ).toEqual(
            expect.arrayContaining(["claim_token", "claim_version", "claim_expires_at", "attachment_base_cookie"])
        );
        const claimed = db.transaction(() => claimDueGatewaySnapshot(sql, { nowMs: 200, attemptExpiresAt: 300 }))();
        expect(claimed).toMatchObject({
            registrationId: current.registrationId,
            cookie: "cookie-legacy-outbox",
            claimVersion: 1,
        });

        db.query(
            `UPDATE _gw_snapshot_outbox
             SET claim_token = 'partial-claim', claim_expires_at = NULL, claim_version = 1
             WHERE registration_id = ?`
        ).run(current.registrationId);
        await bootstrapGateway();
        expect(
            db
                .query(
                    `SELECT claim_token, claim_expires_at, claim_version
                 FROM _gw_snapshot_outbox WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({ claim_token: null, claim_expires_at: null, claim_version: 2 });
    });

    test("restart repairs a partial run triple after the lease column already exists", async () => {
        const current = registration("registration-partial-run");
        installActive(current);
        db.query(
            `UPDATE _gw_registration_generations
             SET run_token = 'partial-token', run_target_version = 5,
                 run_lease_expires_at = NULL, run_version = 1
             WHERE registration_id = ?`
        ).run(current.registrationId);

        await bootstrapGateway();

        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at, run_version
                     FROM _gw_registration_generations WHERE registration_id = ?`
                )
                .get(current.registrationId)
        ).toEqual({ run_token: null, run_target_version: null, run_lease_expires_at: null, run_version: 2 });
    });

    test("bootstrap adds the lease column and clears partial pre-release run state", async () => {
        db.close();
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        const outboxMarker = "CREATE TABLE IF NOT EXISTS _gw_snapshot_outbox";
        const legacyDdl = GATEWAY_REGISTRATION_DDL.slice(0, GATEWAY_REGISTRATION_DDL.indexOf(outboxMarker))
            .replace(
                "  run_lease_expires_at INTEGER CHECK (run_lease_expires_at IS NULL OR run_lease_expires_at >= 0),\n",
                ""
            )
            .replace("  last_snapshot_cookie TEXT,\n", "")
            .replace(
                "  initial_snapshot_pending INTEGER NOT NULL DEFAULT 0 CHECK (initial_snapshot_pending IN (0, 1)),\n",
                ""
            );
        db.exec(legacyDdl);
        db.query(
            `INSERT INTO _gw_registration_generations
             (registration_id, principal_id, client_id, sub_id, connection_id, organization_id,
              ref, args_json, intent_json, policy_digest, query_hash, shard_id, source_cdb_id, schema_epoch,
              domain_schema_epoch,
              auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
              lifecycle, cdb_state, dirty_version, delivered_version, run_token, run_target_version,
              run_version, last_cookie, retry_count, retry_at, retry_error, created_at, updated_at)
             VALUES ('registration-legacy', 'principal-1', 'client-1', 1, 'connection-legacy', 'org-1',
                     'queries.ts#messages', '{}', '{}', 'policy-digest', 'query-hash',
                     'logical-shard', 'physical-cdb', 1, 1,
                     1, 2, 3, 'active', 'active', 5, 2, 'legacy-token', 5,
                     4, NULL, 0, NULL, NULL, 100, 100)`
        ).run();
        db.query(
            `INSERT INTO _gw_registration_heads
             (principal_id, client_id, sub_id, registration_id, updated_at)
             VALUES ('principal-1', 'client-1', 1, 'registration-legacy', 100)`
        ).run();
        await bootstrapGateway();

        expect(
            (db.query("PRAGMA table_info('_gw_registration_generations')").all() as { name: string }[]).map(
                column => column.name
            )
        ).toContain("run_lease_expires_at");
        expect(
            (db.query("PRAGMA table_info('_gw_registration_generations')").all() as { name: string }[]).map(
                column => column.name
            )
        ).toContain("last_snapshot_cookie");
        expect(
            (db.query("PRAGMA table_info('_gw_registration_generations')").all() as { name: string }[]).map(
                column => column.name
            )
        ).toContain("initial_snapshot_pending");
        expect(
            db
                .query(
                    `SELECT run_token, run_target_version, run_lease_expires_at, run_version
                     FROM _gw_registration_generations WHERE registration_id = 'registration-legacy'`
                )
                .get()
        ).toEqual({ run_token: null, run_target_version: null, run_lease_expires_at: null, run_version: 5 });
        expect(
            db
                .query(
                    `SELECT initial_snapshot_pending
                 FROM _gw_registration_generations WHERE registration_id = 'registration-legacy'`
                )
                .get()
        ).toEqual({ initial_snapshot_pending: 0 });
        expect(
            db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_gw_snapshot_outbox'").get()
        ).toEqual({ name: "_gw_snapshot_outbox" });
    });
});
