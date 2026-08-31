import { CdbError } from "../../errors.ts";
import { stableJson } from "../../util/canonical.ts";
import { VSHARD_COUNT, vshardOf } from "../../vshard.ts";

export interface CdbReshardFileRecord {
    readonly fileId: string;
    readonly organizationId: string;
    readonly table: string;
    readonly column: string;
    readonly objectKey: string;
    readonly contentType: string;
    readonly size: number;
    readonly sha256: string | null;
    readonly status: "pending" | "ready" | "attached" | "deleting";
    readonly rowId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly placementVshard: number;
}

export interface CdbReshardOrganizationTombstone {
    readonly organizationId: string;
    readonly deletedAt: number;
    readonly placementVshard: number;
    readonly vectorUnprovenTurns: number;
}

export interface CdbReshardStoredFileRow {
    readonly file_id: string;
    readonly organization_id: string;
    readonly table_name: string;
    readonly column_name: string;
    readonly object_key: string;
    readonly content_type: string;
    readonly size: number | bigint;
    readonly sha256: string | null;
    readonly status: CdbReshardFileRecord["status"];
    readonly row_id: string | null;
    readonly created_at: number | bigint;
    readonly updated_at: number | bigint;
    readonly placement_vshard: number | bigint | null;
}

export interface CdbReshardStoredTombstoneRow {
    readonly organization_id: string;
    readonly deleted_at: number | bigint;
    readonly placement_vshard: number | bigint | null;
    readonly vector_unproven_turns: number | bigint;
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message });
}

function safeInteger(value: number | bigint, subject: string, minimum = 0): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) mismatch(`${subject} is invalid`);
    return number;
}

function boundedText(value: string, subject: string): string {
    if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256) {
        mismatch(`${subject} is invalid`);
    }
    return value;
}

function exactPlacement(organizationId: string, stored: number | bigint | null): number {
    const placement = stored === null ? Number.NaN : Number(stored);
    const expected = Number(vshardOf([organizationId]));
    if (!Number.isSafeInteger(placement) || placement < 0 || placement >= VSHARD_COUNT || placement !== expected) {
        mismatch(`organization ${organizationId} has invalid virtual-shard placement`);
    }
    return placement;
}

export function projectCdbReshardFileRecord(row: CdbReshardStoredFileRow): CdbReshardFileRecord {
    const fileId = boundedText(row.file_id, "file id");
    const organizationId = boundedText(row.organization_id, "organization id");
    const table = boundedText(row.table_name, "table");
    const column = boundedText(row.column_name, "column");
    const contentType = boundedText(row.content_type, "content type");
    const placementVshard = exactPlacement(organizationId, row.placement_vshard);
    const objectKey = `v1/${organizationId}/${fileId}`;
    if (row.object_key !== objectKey) mismatch(`file ${fileId} has an unstable object key`);
    const size = safeInteger(row.size, `file ${fileId} size`, 1);
    const createdAt = safeInteger(row.created_at, `file ${fileId} creation time`);
    const updatedAt = safeInteger(row.updated_at, `file ${fileId} update time`);
    const hash = row.sha256;
    if (updatedAt < createdAt) mismatch(`file ${fileId} update time predates its creation`);
    if (hash !== null && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) {
        mismatch(`file ${fileId} hash is invalid`);
    }
    if (!["pending", "ready", "attached", "deleting"].includes(row.status)) {
        mismatch(`file ${fileId} lifecycle state is invalid`);
    }
    if (
        (row.status === "pending" && (hash !== null || row.row_id !== null)) ||
        (row.status === "ready" && (hash === null || row.row_id !== null)) ||
        (row.status === "attached" && (hash === null || row.row_id === null))
    ) {
        mismatch(`file ${fileId} lifecycle state is invalid`);
    }
    if (row.row_id !== null) boundedText(row.row_id, "row id");
    return Object.freeze({
        fileId,
        organizationId,
        table,
        column,
        objectKey,
        contentType,
        size,
        sha256: hash,
        status: row.status,
        rowId: row.row_id,
        createdAt,
        updatedAt,
        placementVshard,
    });
}

export function projectCdbReshardTombstone(row: CdbReshardStoredTombstoneRow): CdbReshardOrganizationTombstone {
    const organizationId = boundedText(row.organization_id, "organization id");
    const vectorUnprovenTurns = safeInteger(
        row.vector_unproven_turns,
        `organization ${organizationId} vector purge turns`
    );
    if (vectorUnprovenTurns > 32) mismatch(`organization ${organizationId} vector purge turns exceed their bound`);
    return Object.freeze({
        organizationId,
        deletedAt: safeInteger(row.deleted_at, `organization ${organizationId} deletion time`),
        placementVshard: exactPlacement(organizationId, row.placement_vshard),
        vectorUnprovenTurns,
    });
}

export function exactCdbReshardFile(left: CdbReshardFileRecord, right: CdbReshardFileRecord): boolean {
    return stableJson(left) === stableJson(right);
}

export function exactCdbReshardTombstone(
    left: CdbReshardOrganizationTombstone,
    right: CdbReshardOrganizationTombstone
): boolean {
    return stableJson(left) === stableJson(right);
}
