import { CdbError, isCdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "../resource-descriptors.ts";
import { CDB_VECTOR_MAX_DELETE_IDS, cdbVectorPhysicalId } from "./cdb-vector-outbox-store.ts";
import {
    type CdbVectorizeMutationIndex,
    deleteCdbVectorizePhysicalIds,
    verifyCdbVectorizePhysicalIdsDeleted,
} from "./cdb-vectorize-adapter.ts";

const VERIFY_POLLS = 32;
const VERIFY_POLL_MS = 1_000;

interface StoredAttemptIdentity {
    readonly vector_id: string;
    readonly resource_id: string;
    readonly physical_version: number | bigint;
}

export interface CdbVectorRecoveryScrubCursor {
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export interface CdbVectorRecoveryScrubPage extends CdbVectorRecoveryScrubCursor {
    readonly processed: number;
    readonly done: boolean;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector recovery scrub: ${message}` });
}

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `vector recovery scrub: ${message}` });
}

function cursor(input: CdbVectorRecoveryScrubCursor): CdbVectorRecoveryScrubCursor {
    if (
        typeof input.afterVectorId !== "string" ||
        new TextEncoder().encode(input.afterVectorId).byteLength > 256 ||
        !Number.isSafeInteger(input.afterPhysicalVersion) ||
        input.afterPhysicalVersion < 0
    ) {
        invalid("cursor is invalid");
    }
    if (input.afterVectorId.length === 0 && input.afterPhysicalVersion !== 0) invalid("initial cursor is invalid");
    return input;
}

function physicalVersion(value: number | bigint): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < 1) invariant("physical version is invalid");
    return projected;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Delete one page of every Vectorize record still represented by the current
 * shard. Recovery calls this while Catalog and every shard are fenced, then
 * restores SQLite and rebuilds only the heads present at the recovery point.
 */
export async function scrubCdbVectorRecoveryPage(input: {
    readonly sql: SyncSql;
    readonly resources: readonly VectorResourceV1[];
    readonly resolveIndex: (binding: string) => CdbVectorizeMutationIndex;
    readonly cursor: CdbVectorRecoveryScrubCursor;
    readonly limit: number;
}): Promise<CdbVectorRecoveryScrubPage> {
    const after = cursor(input.cursor);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CDB_VECTOR_MAX_DELETE_IDS) {
        invalid(`limit must be between 1 and ${CDB_VECTOR_MAX_DELETE_IDS}`);
    }
    const attemptsExist = input.sql.one<{ readonly present: number }>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_chardb_vector_attempts'"
    );
    if (!attemptsExist) return Object.freeze({ ...after, processed: 0, done: true });

    const rows = input.sql.all<StoredAttemptIdentity>(
        `SELECT attempt.vector_id, head.resource_id, attempt.physical_version
         FROM _chardb_vector_attempts AS attempt
         INNER JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
         WHERE attempt.vector_id > ?
            OR (attempt.vector_id = ? AND attempt.physical_version > ?)
         ORDER BY attempt.vector_id, attempt.physical_version
         LIMIT ?`,
        after.afterVectorId,
        after.afterVectorId,
        after.afterPhysicalVersion,
        input.limit + 1
    );
    const selected = rows.slice(0, input.limit);
    if (selected.length === 0) return Object.freeze({ ...after, processed: 0, done: true });

    const resources = new Map<string, VectorResourceV1>(
        input.resources.map(resource => [cdbVectorResourceId(resource), resource])
    );
    const batches = new Map<string, string[]>();
    for (const row of selected) {
        const resource = resources.get(row.resource_id);
        if (!resource) invariant(`resource ${row.resource_id} is not configured`);
        const ids = batches.get(resource.binding) ?? [];
        ids.push(cdbVectorPhysicalId(row.resource_id, row.vector_id, physicalVersion(row.physical_version)));
        batches.set(resource.binding, ids);
    }

    const outcomes = await Promise.allSettled(
        [...batches].map(async ([binding, physicalIds]) => {
            try {
                const index = input.resolveIndex(binding);
                const batch = await deleteCdbVectorizePhysicalIds(index, physicalIds);
                let deleted = await verifyCdbVectorizePhysicalIdsDeleted(index, batch);
                for (let poll = 1; !deleted && poll < VERIFY_POLLS; poll++) {
                    await sleep(VERIFY_POLL_MS);
                    deleted = await verifyCdbVectorizePhysicalIdsDeleted(index, batch);
                }
                if (!deleted) {
                    throw new CdbError({
                        code: "CDB_SHARD_UNAVAILABLE",
                        message: `vector recovery scrub could not prove deletion from binding ${JSON.stringify(binding)}`,
                    });
                }
            } catch (error) {
                if (isCdbError(error)) throw error;
                throw new CdbError({
                    code: "CDB_SHARD_UNAVAILABLE",
                    message: `vector recovery scrub failed for binding ${JSON.stringify(binding)}`,
                    cause: error,
                });
            }
        })
    );
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;

    const last = selected.at(-1) ?? invariant("selected page is empty");
    return Object.freeze({
        processed: selected.length,
        afterVectorId: last.vector_id,
        afterPhysicalVersion: physicalVersion(last.physical_version),
        done: rows.length <= input.limit,
    });
}
