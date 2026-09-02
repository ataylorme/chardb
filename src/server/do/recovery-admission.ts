import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { RECOVERY_OPERATION_ID, type RecoveryAdmissionClock } from "./recovery-coordinator.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS _chardb_recovery_admission (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  operation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'blocked', 'released'))
);
INSERT OR IGNORE INTO _chardb_recovery_admission (singleton, generation, operation_id, state)
VALUES (1, 0, NULL, 'open');`;

export interface RecoveryAdmissionState {
    readonly generation: number;
    readonly operationId: string | null;
    readonly state: "open" | "blocked" | "released";
}

export function initializeRecoveryAdmissionStore(sql: SyncSql): void {
    for (const statement of DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

interface StoredAdmission {
    readonly generation: number | bigint;
    readonly operation_id: string | null;
    readonly state: RecoveryAdmissionState["state"];
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `recovery admission: ${message}` });
}

function generation(value: number | bigint): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < 0) invalid("generation is invalid");
    return projected;
}

export class RecoveryAdmissionStore {
    constructor(private readonly sql: SyncSql) {}

    read(): RecoveryAdmissionState {
        const row = this.sql.one<StoredAdmission>(
            "SELECT generation, operation_id, state FROM _chardb_recovery_admission WHERE singleton = 1"
        );
        if (!row) invalid("state is missing");
        if (
            (row.operation_id !== null && !RECOVERY_OPERATION_ID.test(row.operation_id)) ||
            (row.state === "open" && row.operation_id !== null) ||
            (row.state !== "open" && row.operation_id === null)
        ) {
            invalid("state is inconsistent");
        }
        return { generation: generation(row.generation), operationId: row.operation_id, state: row.state };
    }

    reconcile(clock: RecoveryAdmissionClock): RecoveryAdmissionState {
        if (!Number.isSafeInteger(clock.generation) || clock.generation < 0) invalid("remote generation is invalid");
        if (
            (clock.activeOperationId === null) !== (clock.activeDigest === null) ||
            (clock.activeOperationId !== null && !RECOVERY_OPERATION_ID.test(clock.activeOperationId))
        ) {
            invalid("remote operation is invalid");
        }
        const local = this.read();
        if (clock.generation < local.generation) invalid("remote generation regressed");
        if (clock.generation > local.generation) {
            const next: RecoveryAdmissionState = clock.activeOperationId
                ? { generation: clock.generation, operationId: clock.activeOperationId, state: "blocked" }
                : { generation: clock.generation, operationId: null, state: "open" };
            this.write(next);
            return next;
        }
        if (clock.activeOperationId === null) {
            if (local.state !== "open") this.write({ generation: local.generation, operationId: null, state: "open" });
            return { generation: local.generation, operationId: null, state: "open" };
        }
        if (local.operationId !== clock.activeOperationId) invalid("active operation changed at one generation");
        return local;
    }

    arm(operationId: string, nextGeneration: number): RecoveryAdmissionState {
        if (!RECOVERY_OPERATION_ID.test(operationId) || !Number.isSafeInteger(nextGeneration) || nextGeneration < 1) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "recovery admission identity is invalid" });
        }
        const local = this.read();
        if (nextGeneration < local.generation) invalid("arm generation regressed");
        if (nextGeneration === local.generation) {
            if (local.operationId !== operationId) invalid("arm operation changed at one generation");
            if (local.state === "released") {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "recovery operation was already released" });
            }
            return local;
        }
        const next = { generation: nextGeneration, operationId, state: "blocked" as const };
        this.write(next);
        return next;
    }

    release(operationId: string, expectedGeneration: number): RecoveryAdmissionState {
        const local = this.read();
        if (local.generation !== expectedGeneration || local.operationId !== operationId) {
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "recovery release identity is stale" });
        }
        if (local.state === "released") return local;
        if (local.state !== "blocked") invalid("open admission cannot be released");
        const next = { ...local, state: "released" as const };
        this.write(next);
        return next;
    }

    assertRequest(expectedGeneration: number): void {
        const local = this.read();
        if (
            !Number.isSafeInteger(expectedGeneration) ||
            expectedGeneration < 0 ||
            local.state === "blocked" ||
            local.generation !== expectedGeneration
        ) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "request belongs to another recovery generation",
                hint: "resolve current authorization and routing from Catalog, then retry",
            });
        }
    }

    blocksBackgroundWork(): boolean {
        return this.read().state === "blocked";
    }

    private write(value: RecoveryAdmissionState): void {
        this.sql.exec(
            `UPDATE _chardb_recovery_admission
             SET generation = ?, operation_id = ?, state = ? WHERE singleton = 1`,
            value.generation,
            value.operationId,
            value.state
        );
        if (this.sql.changes() !== 1) invalid("state update failed");
    }
}
