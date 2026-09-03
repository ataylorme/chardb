import { client } from "@chardb/core";
import { chardb } from "@chardb/core/server";
import * as api from "./api.ts";
import { auth } from "./auth.ts";
import { migrations } from "./migrations.ts";
import * as schema from "./schema.ts";
import {
    type VectorProofFaultMode,
    type VectorProofMutationEvidence,
    type VectorProofStateDiagnosticCode,
    type VectorProofStateRpcResult,
    assertVectorProofSearchAuditSequence,
    parseVectorProofPhysicalIds,
    parseVectorProofStateRpcResult,
    parseVectorProofTerminalFlag,
    requireNullableVectorProofSqlFlag,
    requireNullableVectorProofSqlInteger,
    requireVectorProofSqlFlag,
    requireVectorProofSqlInteger,
    resolveVectorProofFaultPhysicalIds,
    scopeVectorProofFaultPhysicalIds,
    validateVectorProofAcceptanceIdentity,
    vectorProofFaultArmDecision,
    vectorProofFaultOperation,
    vectorProofMutationEvidence,
    vectorProofMutationIdHash,
    vectorProofSha256,
    vectorProofSha256Result,
    vectorProofStateFailure,
    vectorProofStateSuccess,
} from "./vector-fault-evidence.ts";
import {
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
    type CdbVectorizeMutationIndex,
    type CdbVectorizeRecord,
    type CdbVectorizeSearchIndex,
    cdbVectorLogicalId,
    cdbVectorResourceId,
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
    collectSchemaResourceDescriptors,
    isChardbVectorResourceDescriptor,
    parseCdbVectorizePhysicalId,
    vshardOf,
} from "./vector-proof.ts";

interface ProofEnv {
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_PROOF_RUN_ID: string;
    readonly CDB_PROOF_VECTORS: VectorizeIndex;
    readonly CDB_RELEASE_SHA256: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly DB: Parameters<typeof client>[0];
}

interface ProofCdbRpc {
    proofArmVectorFault(input: {
        readonly mode: VectorProofFaultMode;
        readonly vectorId: string;
    }): Promise<{ readonly armed: true; readonly mode: string; readonly vectorId: string }>;
    proofReleaseVectorGate(input: {
        readonly vectorId: string;
        readonly gateDeadline: number;
        readonly physicalIds: readonly string[];
        readonly payloadSha256: string;
    }): Promise<{ readonly released: true; readonly gateDeadline: number }>;
    proofVectorState(vectorId: string): Promise<VectorProofStateRpcResult>;
    proofVectorIntent(input: {
        readonly action: "create" | "replace" | "delete";
        readonly organizationId: string;
        readonly id: string;
    }): Promise<unknown>;
    proofVectorAdversary(input: {
        readonly action: "inspect" | "apply" | "restore";
        readonly organizationId: string;
        readonly id: string;
        readonly staleValues?: readonly number[];
        readonly currentValues?: readonly number[];
    }): Promise<{
        readonly action: "inspect" | "apply" | "restore";
        readonly vectorId: string;
        readonly stalePhysicalId: string;
        readonly currentPhysicalId: string;
        readonly upsertMutationIdSha256: string | null;
        readonly deleteMutationIdSha256: string | null;
    }>;
    proofVectorSearchAudit(input: {
        readonly action: "cursor" | "observe";
        readonly organizationId: string;
        readonly id: string;
        readonly values: readonly number[];
        readonly afterSequence?: number;
    }): Promise<{
        readonly sequence: number;
        readonly querySha256: string | null;
        readonly candidateSetSha256: string | null;
        readonly candidateCount: number;
        readonly stalePresent: boolean;
        readonly currentPresent: boolean;
        readonly otherCandidateCount: number;
    }>;
}

interface ProofCatalogRpc {
    route(vshard: number): Promise<{ readonly shardId: string }>;
}

interface StoredProofFault {
    readonly vector_id: string | null;
    readonly mode: VectorProofFaultMode;
    readonly armed: number;
    readonly in_flight: number;
    readonly fired: number;
    readonly first_ids_json: string | null;
    readonly first_payload_sha256: string | null;
    readonly returned_mutation_sha256: string | null;
    readonly accepted_before_throw: number;
    readonly retry_count: number;
    readonly retry_ids_match: number | null;
    readonly retry_payload_match: number | null;
    readonly retry_complete: number;
    readonly gate_open: number;
    readonly gate_deadline: number | null;
    readonly updated_at: number;
}

interface StoredProofAcceptance extends Record<string, SqlStorageValue> {
    readonly vector_id: string;
    readonly physical_id: string;
    readonly operation: "upsert" | "delete";
    readonly payload_sha256: string;
    readonly mutation_sha256: string;
    readonly accepted_at: number;
}

const PROOF_UPSERT_GATE_TIMEOUT_MS = 10 * 60_000;
const PROOF_UPSERT_GATE_POLL_MS = 100;
const PROOF_SHA256 = /^[a-f0-9]{64}$/;
const PROOF_RESOURCE_ID = /^vr1_[a-f0-9]{64}$/;

const PROOF_FAULT_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_vector_proof_fault (
  singleton                    INTEGER PRIMARY KEY CHECK (singleton = 1),
  vector_id                    TEXT NOT NULL CHECK (length(vector_id) BETWEEN 1 AND 128),
  mode                         TEXT NOT NULL CHECK (mode IN ('upsert_accept_then_throw', 'delete_accept_then_throw')),
  armed                        INTEGER NOT NULL CHECK (armed IN (0, 1)),
  in_flight                    INTEGER NOT NULL CHECK (in_flight IN (0, 1)),
  fired                        INTEGER NOT NULL CHECK (fired IN (0, 1)),
  first_ids_json               TEXT CHECK (first_ids_json IS NULL OR length(CAST(first_ids_json AS BLOB)) <= 4096),
  first_payload_sha256         TEXT CHECK (first_payload_sha256 IS NULL OR length(first_payload_sha256) = 64),
  returned_mutation_sha256     TEXT CHECK (returned_mutation_sha256 IS NULL OR length(returned_mutation_sha256) = 64),
  accepted_before_throw        INTEGER NOT NULL CHECK (accepted_before_throw IN (0, 1)),
  retry_count                  INTEGER NOT NULL CHECK (retry_count BETWEEN 0 AND 64),
  retry_ids_match              INTEGER CHECK (retry_ids_match IS NULL OR retry_ids_match IN (0, 1)),
  retry_payload_match          INTEGER CHECK (retry_payload_match IS NULL OR retry_payload_match IN (0, 1)),
  retry_complete               INTEGER NOT NULL CHECK (retry_complete IN (0, 1)),
  gate_open                    INTEGER NOT NULL DEFAULT 0 CHECK (gate_open IN (0, 1)),
  gate_deadline                INTEGER CHECK (gate_deadline IS NULL OR gate_deadline >= 0),
  updated_at                   INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (NOT (armed = 1 AND fired = 1)),
  CHECK (NOT (in_flight = 1 AND armed = 0))
);`;

const PROOF_ACCEPTANCE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_vector_proof_acceptance (
  vector_id                    TEXT NOT NULL,
  physical_id                  TEXT NOT NULL,
  operation                    TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_sha256               TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  mutation_sha256              TEXT NOT NULL CHECK (length(mutation_sha256) = 64),
  accepted_at                  INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (physical_id, operation)
);
CREATE INDEX IF NOT EXISTS _chardb_vector_proof_acceptance_by_vector
ON _chardb_vector_proof_acceptance (vector_id, operation, accepted_at, physical_id);`;

const PROOF_SEARCH_AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_vector_proof_search_audit (
  sequence                     INTEGER PRIMARY KEY AUTOINCREMENT,
  query_sha256                 TEXT NOT NULL CHECK (length(query_sha256) = 64),
  candidate_set_sha256         TEXT NOT NULL CHECK (length(candidate_set_sha256) = 64),
  candidate_ids_json           TEXT NOT NULL CHECK (length(CAST(candidate_ids_json AS BLOB)) <= 8192),
  created_at                   INTEGER NOT NULL CHECK (created_at >= 0)
);`;

const app = chardb({ ownership: "organization", auth, authBasePath: "/api/auth", schema, api, migrations });
const vectorResources = collectSchemaResourceDescriptors(schema).filter(isChardbVectorResourceDescriptor);

function bearer(value: string | undefined): string {
    return value?.replace(/^Bearer\s+/i, "") ?? "";
}

async function digest(value: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function sameSecret(left: string, right: string): Promise<boolean> {
    const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
    let different = leftHash.length ^ rightHash.length;
    for (let index = 0; index < leftHash.length; index++) {
        different |= (leftHash[index] ?? 0) ^ (rightHash[index] ?? 0);
    }
    return different === 0 && left.length > 0 && right.length > 0;
}

async function proofAuthorized(request: { header(name: string): string | undefined }, env: ProofEnv): Promise<boolean> {
    const runId = request.header("x-chardb-proof-run-id") ?? "";
    const token = bearer(request.header("authorization"));
    return runId.length > 0 && runId === env.CDB_PROOF_RUN_ID && (await sameSecret(token, env.CDB_ADMIN_TOKEN));
}

function exactOrganizationId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new TypeError("proof organization id is invalid");
    return value;
}

function exactVectorId(value: string): string {
    if (!/^vec1_[a-f0-9]{64}$/.test(value)) throw new TypeError("proof vector id is invalid");
    return value;
}

function exactDocumentId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new TypeError("proof vector document id is invalid");
    }
    return value;
}

function exactIntentAction(value: string): "create" | "replace" | "delete" {
    if (value !== "create" && value !== "replace" && value !== "delete") {
        throw new TypeError("proof vector intent action is invalid");
    }
    return value;
}

function exactAdversaryAction(value: string): "inspect" | "apply" | "restore" {
    if (value !== "inspect" && value !== "apply" && value !== "restore") {
        throw new TypeError("proof vector adversary action is invalid");
    }
    return value;
}

function exactProofVectorValues(value: unknown): readonly number[] {
    if (!Array.isArray(value) || value.length !== 32) {
        throw new TypeError("proof vector adversary values are invalid");
    }
    return Object.freeze(
        value.map(item => {
            if (typeof item !== "number" || !Number.isFinite(item)) {
                throw new TypeError("proof vector adversary values are invalid");
            }
            const rounded = new Float32Array([item])[0];
            if (rounded === undefined || !Number.isFinite(rounded)) {
                throw new TypeError("proof vector adversary values exceed float32 range");
            }
            return rounded;
        })
    );
}

async function proofCdb(env: ProofEnv, organizationId: string): Promise<ProofCdbRpc> {
    const owner = exactOrganizationId(organizationId);
    const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as ProofCatalogRpc;
    const route = await catalog.route(Number(vshardOf([owner])));
    if (!route || typeof route.shardId !== "string" || route.shardId.length === 0 || route.shardId.length > 128) {
        throw new TypeError("proof Catalog route is invalid");
    }
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(route.shardId)) as unknown as ProofCdbRpc;
}

function one<T>(storage: DurableObjectStorage, query: string, ...bindings: unknown[]): T | null {
    return (storage.sql.exec(query, ...bindings).toArray()[0] as T | undefined) ?? null;
}

function ensureProofFaultStore(storage: DurableObjectStorage): void {
    storage.sql.exec(PROOF_FAULT_DDL);
    storage.sql.exec(PROOF_ACCEPTANCE_DDL);
    storage.sql.exec(PROOF_SEARCH_AUDIT_DDL);
    const columns = new Set(
        storage.sql
            .exec<{ name: string }>("PRAGMA table_info(_chardb_vector_proof_fault)")
            .toArray()
            .map(column => column.name)
    );
    if (!columns.has("gate_open")) {
        storage.sql.exec(
            "ALTER TABLE _chardb_vector_proof_fault ADD COLUMN gate_open INTEGER NOT NULL DEFAULT 0 CHECK (gate_open IN (0, 1))"
        );
    }
    if (!columns.has("gate_deadline")) {
        storage.sql.exec(
            "ALTER TABLE _chardb_vector_proof_fault ADD COLUMN gate_deadline INTEGER CHECK (gate_deadline IS NULL OR gate_deadline >= 0)"
        );
    }
    if (!columns.has("vector_id")) {
        storage.sql.exec("ALTER TABLE _chardb_vector_proof_fault ADD COLUMN vector_id TEXT");
    }
    const legacy = one<Pick<StoredProofFault, "vector_id" | "first_ids_json"> & Record<string, SqlStorageValue>>(
        storage,
        "SELECT vector_id, first_ids_json FROM _chardb_vector_proof_fault WHERE singleton = 1"
    );
    if (legacy?.vector_id === null) {
        const ownership = resolveVectorProofFaultPhysicalIds(legacy.first_ids_json, null, parseCdbVectorizePhysicalId);
        if (!ownership.ok) throw new TypeError("legacy proof vector fault has no trustworthy logical owner");
        const vectorId = exactVectorId(ownership.vectorId);
        storage.sql.exec(
            "UPDATE _chardb_vector_proof_fault SET vector_id = ? WHERE singleton = 1 AND vector_id IS NULL",
            vectorId
        );
        if (one<{ count: number }>(storage, "SELECT changes() AS count")?.count !== 1) {
            throw new TypeError("legacy proof vector fault ownership upgrade raced another request");
        }
    }
}

function assertProofFaultStore(storage: DurableObjectStorage): ReadonlySet<string> {
    const tables = storage.sql
        .exec<{ name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('_chardb_vector_proof_fault', '_chardb_vector_proof_acceptance')
             ORDER BY name`
        )
        .toArray();
    if (
        tables.length !== 2 ||
        tables[0]?.name !== "_chardb_vector_proof_acceptance" ||
        tables[1]?.name !== "_chardb_vector_proof_fault"
    ) {
        throw new TypeError("proof vector state store is not initialized");
    }
    const columns = new Set(
        storage.sql
            .exec<{ name: string }>("PRAGMA table_info(_chardb_vector_proof_fault)")
            .toArray()
            .map(column => column.name)
    );
    for (const required of [
        "singleton",
        "mode",
        "armed",
        "in_flight",
        "fired",
        "first_ids_json",
        "first_payload_sha256",
        "returned_mutation_sha256",
        "accepted_before_throw",
        "retry_count",
        "retry_ids_match",
        "retry_payload_match",
        "retry_complete",
        "updated_at",
    ]) {
        if (!columns.has(required)) throw new TypeError("proof vector state store columns are invalid");
    }
    return columns;
}

function parsePhysicalIds(value: unknown): readonly string[] {
    const result = parseVectorProofPhysicalIds(value, parseCdbVectorizePhysicalId);
    if (!result.ok) throw new TypeError("stored proof physical ids are invalid");
    return result.ids;
}

function proofText(value: unknown, maximumBytes: number, allowEmpty = false): string {
    if (
        typeof value !== "string" ||
        (!allowEmpty && value.length === 0) ||
        new TextEncoder().encode(value).byteLength > maximumBytes
    ) {
        throw new TypeError("proof SQL text is invalid");
    }
    return value;
}

function proofNullableText(value: unknown, maximumBytes: number): string | null {
    return value === null ? null : proofText(value, maximumBytes);
}

function proofSha256(value: unknown): string {
    if (typeof value !== "string" || !PROOF_SHA256.test(value)) throw new TypeError("proof SQL digest is invalid");
    return value;
}

function proofNullableSha256(value: unknown): string | null {
    return value === null ? null : proofSha256(value);
}

app.get("/health", c => {
    const env = c.env as unknown as ProofEnv;
    return c.json({
        ok: true,
        schemaVersion: migrations.version,
        releaseSha256: env.CDB_RELEASE_SHA256,
        vectorResources: vectorResources.length,
        proofConfigured:
            typeof env.CDB_ADMIN_TOKEN === "string" &&
            env.CDB_ADMIN_TOKEN.length > 0 &&
            typeof env.CDB_PROOF_RUN_ID === "string" &&
            env.CDB_PROOF_RUN_ID.length > 0,
    });
});

app.post("/api/vector-documents", async c => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    const body = await c.req.json<{
        readonly action: "create" | "replace" | "delete";
        readonly id: string;
        readonly organizationId: string;
        readonly text?: string;
        readonly values?: number[];
        readonly mutId: string;
    }>();
    const database = client(c.env.DB, { jwt: token, authOrigin: new URL(c.req.url).origin });
    if (body.action === "delete") {
        return c.json(
            await database.mutate(
                api.deleteVectorDocument,
                { id: body.id, organizationId: body.organizationId },
                { mutId: body.mutId }
            )
        );
    }
    const operation = body.action === "replace" ? api.replaceVectorDocument : api.createVectorDocument;
    return c.json(
        await database.mutate(
            operation,
            {
                id: body.id,
                organizationId: body.organizationId,
                body: body.text ?? "",
                values: body.values ?? [],
            },
            { mutId: body.mutId }
        )
    );
});

app.get("/api/vector-documents", async c => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    const organizationId = c.req.query("organizationId") ?? "";
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = await client(c.env.DB, { jwt: token, authOrigin: new URL(c.req.url).origin }).query(
        api.listVectorDocuments,
        { organizationId, limit }
    );
    return c.json(rows);
});

app.post("/api/vector-search", async c => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    const body = await c.req.json<{
        readonly organizationId: string;
        readonly values: number[];
        readonly limit: number;
    }>();
    const result = await client(c.env.DB, { jwt: token, authOrigin: new URL(c.req.url).origin }).query(
        api.searchVectorDocuments,
        body
    );
    return c.json(result);
});

app.post("/proof/vector-fault/arm", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly organizationId: string;
        readonly mode: VectorProofFaultMode;
        readonly vectorId: string;
    }>();
    vectorProofFaultOperation(body.mode);
    return c.json(
        await (await proofCdb(env, body.organizationId)).proofArmVectorFault({
            mode: body.mode,
            vectorId: exactVectorId(body.vectorId),
        })
    );
});

app.post("/proof/vector-fault/release", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly organizationId: string;
        readonly vectorId: string;
        readonly gateDeadline: number;
        readonly physicalIds: readonly string[];
        readonly payloadSha256: string;
    }>();
    return c.json(
        await (await proofCdb(env, body.organizationId)).proofReleaseVectorGate({
            vectorId: exactVectorId(body.vectorId),
            gateDeadline: body.gateDeadline,
            physicalIds: body.physicalIds,
            payloadSha256: body.payloadSha256,
        })
    );
});

app.get("/proof/vector-intent", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const organizationId = exactOrganizationId(c.req.query("organizationId") ?? "");
    const id = exactDocumentId(c.req.query("id") ?? "");
    const action = exactIntentAction(c.req.query("action") ?? "");
    return c.json(await (await proofCdb(env, organizationId)).proofVectorIntent({ action, organizationId, id }));
});

app.post("/proof/vector-descriptor", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ readonly organizationIds: readonly string[] }>();
    if (!Array.isArray(body.organizationIds) || body.organizationIds.length !== 2) {
        throw new TypeError("proof vector descriptor requires exactly two organizations");
    }
    const organizationIds = body.organizationIds.map(exactOrganizationId);
    if (new Set(organizationIds).size !== 2) throw new TypeError("proof vector descriptor organizations must differ");
    if (vectorResources.length !== 1 || !vectorResources[0]) {
        throw new TypeError("proof requires exactly one vector resource");
    }
    const resource = vectorResources[0];
    const resourceId = cdbVectorResourceId(resource);
    return c.json({
        descriptor: {
            binding: resource.binding,
            resourceDigest: resourceId.slice("vr1_".length),
            resourceId,
            resourceFilter: cdbVectorizeResourceFilter(resourceId),
            dimensions: resource.dimensions,
            metric: resource.metric,
            namespaceIds: organizationIds.map(cdbVectorizeOrganizationNamespace),
        },
        search: {
            resourceFilter: true,
            currentHeadOnly: true,
            noRemoteValues: true,
            noRemoteMetadata: true,
        },
        settlementConfiguredMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
    });
});

app.post("/proof/vector-adversary", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly action: "apply" | "restore";
        readonly organizationId: string;
        readonly id: string;
        readonly staleValues: readonly number[];
        readonly currentValues: readonly number[];
    }>();
    const action = exactAdversaryAction(body.action);
    if (action === "inspect") throw new TypeError("proof vector adversary mutation action is invalid");
    return c.json(
        await (await proofCdb(env, exactOrganizationId(body.organizationId))).proofVectorAdversary({
            action,
            organizationId: body.organizationId,
            id: exactDocumentId(body.id),
            staleValues: exactProofVectorValues(body.staleValues),
            currentValues: exactProofVectorValues(body.currentValues),
        })
    );
});

app.post("/proof/vector-adversary/query", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly organizationId: string;
        readonly id: string;
        readonly values: readonly number[];
    }>();
    const organizationId = exactOrganizationId(body.organizationId);
    const id = exactDocumentId(body.id);
    const values = exactProofVectorValues(body.values);
    const inspected = await (await proofCdb(env, organizationId)).proofVectorAdversary({
        action: "inspect",
        organizationId,
        id,
    });
    if (vectorResources.length !== 1 || !vectorResources[0]) {
        throw new TypeError("proof requires exactly one vector resource");
    }
    const resourceId = cdbVectorResourceId(vectorResources[0]);
    const raw = await env.CDB_PROOF_VECTORS.query([...values], {
        topK: 17,
        namespace: cdbVectorizeOrganizationNamespace(organizationId),
        returnValues: false,
        returnMetadata: "none",
        filter: { cdb_resource: cdbVectorizeResourceFilter(resourceId) },
    });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new TypeError("proof Vectorize adversary query returned an invalid result");
    }
    const matches = (raw as { readonly matches?: unknown }).matches;
    if (!Array.isArray(matches) || matches.length > 17) {
        throw new TypeError("proof Vectorize adversary query returned invalid matches");
    }
    const projected = matches.map((match, index) => {
        if (typeof match !== "object" || match === null || Array.isArray(match)) {
            throw new TypeError(`proof Vectorize adversary match ${index} is invalid`);
        }
        const physicalId = (match as { readonly id?: unknown }).id;
        const score = (match as { readonly score?: unknown }).score;
        if (typeof physicalId !== "string" || !parseCdbVectorizePhysicalId(physicalId)) {
            throw new TypeError(`proof Vectorize adversary match ${index} has an invalid physical id`);
        }
        if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new TypeError(`proof Vectorize adversary match ${index} has an invalid score`);
        }
        return Object.freeze({ physicalId, score: Object.is(score, -0) ? 0 : score });
    });
    if (new Set(projected.map(match => match.physicalId)).size !== projected.length) {
        throw new TypeError("proof Vectorize adversary query returned duplicate physical ids");
    }
    return c.json({ ...inspected, matches: projected });
});

app.post("/proof/vector-presence", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly organizationId: string;
        readonly vectorId: string;
        readonly versions: readonly number[];
    }>();
    exactOrganizationId(body.organizationId);
    const vectorId = exactVectorId(body.vectorId);
    if (
        !Array.isArray(body.versions) ||
        body.versions.length !== 2 ||
        body.versions[0] !== 1 ||
        body.versions[1] !== 2
    ) {
        throw new TypeError("proof vector presence requires physical versions 1 and 2");
    }
    const physicalIds = body.versions.map(version => cdbVectorizePhysicalId(vectorId, version));
    const records = await env.CDB_PROOF_VECTORS.getByIds([...physicalIds]);
    if (!Array.isArray(records) || records.length > physicalIds.length) {
        throw new TypeError("proof Vectorize presence returned an invalid result");
    }
    const present = new Set<string>();
    for (const record of records) {
        if (typeof record !== "object" || record === null || !physicalIds.includes(record.id)) {
            throw new TypeError("proof Vectorize presence returned an unexpected record");
        }
        if (present.has(record.id)) throw new TypeError("proof Vectorize presence returned a duplicate record");
        present.add(record.id);
    }
    return c.json({
        vectorId,
        records: physicalIds.map(physicalId => ({ physicalId, present: present.has(physicalId) })),
    });
});

app.post("/proof/vector-search-audit", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
        readonly action: "cursor" | "observe";
        readonly organizationId: string;
        readonly id: string;
        readonly values: readonly number[];
        readonly afterSequence?: number;
    }>();
    return c.json(
        await (await proofCdb(env, exactOrganizationId(body.organizationId))).proofVectorSearchAudit({
            action: body.action,
            organizationId: body.organizationId,
            id: exactDocumentId(body.id),
            values: exactProofVectorValues(body.values),
            ...(body.afterSequence === undefined ? {} : { afterSequence: body.afterSequence }),
        })
    );
});

app.get("/proof/vector-state", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const organizationId = c.req.query("organizationId") ?? "";
    const vectorId = exactVectorId(c.req.query("vectorId") ?? "");
    let cdb: ProofCdbRpc;
    try {
        cdb = await proofCdb(env, organizationId);
    } catch {
        return c.json(vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_ROUTE_FAILED"), 500);
    }
    let raw: unknown;
    try {
        raw = await cdb.proofVectorState(vectorId);
    } catch {
        return c.json(vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RPC_FAILED"), 500);
    }
    let result: VectorProofStateRpcResult;
    try {
        result = parseVectorProofStateRpcResult(raw);
    } catch {
        return c.json(vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RPC_RESULT_INVALID"), 500);
    }
    try {
        return result.ok ? c.json(result.state) : c.json(result, 500);
    } catch {
        return c.json(vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RESPONSE_JSON_FAILED"), 500);
    }
});

app.post("/proof/add-member", async c => {
    const env = c.env as unknown as ProofEnv;
    if (!(await proofAuthorized(c.req, env))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ readonly organizationId: string; readonly userId: string }>();
    const member = await c.var.auth.api.addMember({
        body: { organizationId: body.organizationId, userId: body.userId, role: "member" },
    });
    return c.json({ id: member.id, organizationId: member.organizationId, userId: member.userId, role: member.role });
});

export class Cdb extends app.Cdb {
    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        const real = super.resolveVectorIndex(binding);
        if (binding !== "CDB_PROOF_VECTORS") return real;
        ensureProofFaultStore(this.ctx.storage);
        return {
            upsert: (records: readonly CdbVectorizeRecord[]) =>
                this.proofVectorMutation(
                    "upsert",
                    vectorProofMutationEvidence("upsert", records, parseCdbVectorizePhysicalId),
                    () => real.upsert(records)
                ),
            deleteByIds: (ids: readonly string[]) =>
                this.proofVectorMutation(
                    "delete",
                    vectorProofMutationEvidence("delete", ids, parseCdbVectorizePhysicalId),
                    () => real.deleteByIds(ids)
                ),
            getByIds: (ids: readonly string[]) => real.getByIds(ids),
            describe: () => {
                const describe = real.describe;
                if (typeof describe !== "function") {
                    throw new TypeError("Vectorize proof requires the V2 describe capability");
                }
                return describe.call(real);
            },
        };
    }

    protected override resolveVectorSearchIndex(binding: string): CdbVectorizeSearchIndex {
        const real = super.resolveVectorSearchIndex(binding);
        if (binding !== "CDB_PROOF_VECTORS") return real;
        ensureProofFaultStore(this.ctx.storage);
        return {
            query: async (
                values: readonly number[],
                options: {
                    readonly topK: number;
                    readonly namespace: string;
                    readonly returnValues: false;
                    readonly returnMetadata: "none";
                    readonly filter: { readonly cdb_resource: string };
                }
            ) => {
                const receipt = await real.query(values, options);
                if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
                    throw new TypeError("proof Vectorize search audit received an invalid receipt");
                }
                const matches = (receipt as { readonly matches?: unknown }).matches;
                if (!Array.isArray(matches) || matches.length > 17) {
                    throw new TypeError("proof Vectorize search audit received invalid matches");
                }
                const ids = matches.map((match, index) => {
                    if (typeof match !== "object" || match === null || Array.isArray(match)) {
                        throw new TypeError(`proof Vectorize search audit match ${index} is invalid`);
                    }
                    const id = (match as { readonly id?: unknown }).id;
                    if (typeof id !== "string" || !parseCdbVectorizePhysicalId(id)) {
                        throw new TypeError(`proof Vectorize search audit match ${index} has an invalid physical id`);
                    }
                    return id;
                });
                if (new Set(ids).size !== ids.length) {
                    throw new TypeError("proof Vectorize search audit received duplicate physical ids");
                }
                const querySha256 = await vectorProofSha256(JSON.stringify({ values: [...values], options }));
                const candidateIdsJson = JSON.stringify(ids);
                const candidateSetSha256 = await vectorProofSha256(candidateIdsJson);
                this.ctx.storage.transactionSync(() => {
                    this.ctx.storage.sql.exec(
                        `INSERT INTO _chardb_vector_proof_search_audit
                           (query_sha256, candidate_set_sha256, candidate_ids_json, created_at)
                         VALUES (?, ?, ?, ?)`,
                        querySha256,
                        candidateSetSha256,
                        candidateIdsJson,
                        Date.now()
                    );
                    this.ctx.storage.sql.exec(
                        `DELETE FROM _chardb_vector_proof_search_audit
                         WHERE sequence NOT IN (
                           SELECT sequence FROM _chardb_vector_proof_search_audit ORDER BY sequence DESC LIMIT 64
                         )`
                    );
                });
                return receipt;
            },
        };
    }

    async proofVectorSearchAudit(input: {
        readonly action: "cursor" | "observe";
        readonly organizationId: string;
        readonly id: string;
        readonly values: readonly number[];
        readonly afterSequence?: number;
    }): Promise<{
        readonly sequence: number;
        readonly querySha256: string | null;
        readonly candidateSetSha256: string | null;
        readonly candidateCount: number;
        readonly stalePresent: boolean;
        readonly currentPresent: boolean;
        readonly otherCandidateCount: number;
    }> {
        ensureProofFaultStore(this.ctx.storage);
        const organizationId = exactOrganizationId(input.organizationId);
        const id = exactDocumentId(input.id);
        const values = exactProofVectorValues(input.values);
        if (vectorResources.length !== 1 || !vectorResources[0]) {
            throw new TypeError("proof requires exactly one vector resource");
        }
        const resource = vectorResources[0];
        const resourceId = cdbVectorResourceId(resource);
        const vectorId = cdbVectorLogicalId(resourceId, organizationId, id);
        const stalePhysicalId = cdbVectorizePhysicalId(vectorId, 1);
        const currentPhysicalId = cdbVectorizePhysicalId(vectorId, 2);
        const options = {
            topK: 17,
            namespace: cdbVectorizeOrganizationNamespace(organizationId),
            returnValues: false as const,
            returnMetadata: "none" as const,
            filter: { cdb_resource: cdbVectorizeResourceFilter(resourceId) },
        };
        const querySha256 = await vectorProofSha256(JSON.stringify({ values: [...values], options }));
        const latest = one<{ sequence: number }>(
            this.ctx.storage,
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM _chardb_vector_proof_search_audit"
        );
        const latestSequence = latest?.sequence ?? 0;
        if (!Number.isSafeInteger(latestSequence) || latestSequence < 0) {
            throw new TypeError("proof Vectorize search audit cursor is invalid");
        }
        if (input.action === "cursor") {
            return Object.freeze({
                sequence: latestSequence,
                querySha256: null,
                candidateSetSha256: null,
                candidateCount: 0,
                stalePresent: false,
                currentPresent: false,
                otherCandidateCount: 0,
            });
        }
        const afterSequence = input.afterSequence;
        if (
            input.action !== "observe" ||
            !Number.isSafeInteger(afterSequence) ||
            afterSequence === undefined ||
            afterSequence < 0
        ) {
            throw new TypeError("proof Vectorize search audit observation cursor is invalid");
        }
        const row = one<{
            sequence: number;
            query_sha256: string;
            candidate_set_sha256: string;
            candidate_ids_json: string;
        }>(
            this.ctx.storage,
            `SELECT sequence, query_sha256, candidate_set_sha256, candidate_ids_json
             FROM _chardb_vector_proof_search_audit
             WHERE sequence > ? ORDER BY sequence LIMIT 1`,
            afterSequence
        );
        if (!row || proofSha256(row.query_sha256) !== querySha256) {
            throw new TypeError("proof Vectorize search audit did not correlate the exact public query");
        }
        assertVectorProofSearchAuditSequence(afterSequence, latestSequence, row.sequence);
        const candidateIds = parsePhysicalIds(row.candidate_ids_json);
        if ((await vectorProofSha256(JSON.stringify(candidateIds))) !== proofSha256(row.candidate_set_sha256)) {
            throw new TypeError("proof Vectorize search audit candidate digest drifted");
        }
        const stalePresent = candidateIds.includes(stalePhysicalId);
        const currentPresent = candidateIds.includes(currentPhysicalId);
        const otherCandidateCount = candidateIds.filter(
            candidate => candidate !== stalePhysicalId && candidate !== currentPhysicalId
        ).length;
        return Object.freeze({
            sequence: row.sequence,
            querySha256,
            candidateSetSha256: row.candidate_set_sha256,
            candidateCount: candidateIds.length,
            stalePresent,
            currentPresent,
            otherCandidateCount,
        });
    }

    proofArmVectorFault(input: {
        readonly mode: VectorProofFaultMode;
        readonly vectorId: string;
    }): { readonly armed: true; readonly mode: string; readonly vectorId: string } {
        const mode = input.mode;
        const vectorId = exactVectorId(input.vectorId);
        vectorProofFaultOperation(mode);
        this.ctx.storage.transactionSync(() => {
            ensureProofFaultStore(this.ctx.storage);
            const current = one<StoredProofFault>(
                this.ctx.storage,
                `SELECT vector_id, mode, armed, in_flight, fired, first_ids_json, first_payload_sha256,
                        returned_mutation_sha256, accepted_before_throw, retry_count, retry_ids_match,
                        retry_payload_match, retry_complete, gate_open, gate_deadline, updated_at
                 FROM _chardb_vector_proof_fault WHERE singleton = 1`
            );
            const currentVectorId = current ? exactVectorId(current.vector_id ?? "") : null;
            const currentIds = current
                ? scopeVectorProofFaultPhysicalIds(
                      current.first_ids_json,
                      currentVectorId ?? "",
                      currentVectorId ?? "",
                      parseCdbVectorizePhysicalId
                  )
                : null;
            if (currentIds && (!currentIds.ok || !currentIds.appliesToExpectedVector)) {
                throw new TypeError("stored proof vector fault changed logical ownership");
            }
            const decision = vectorProofFaultArmDecision(
                current
                    ? {
                          vectorId: currentVectorId ?? "",
                          mode: current.mode,
                          armed: requireVectorProofSqlFlag(current.armed),
                          inFlight: requireVectorProofSqlFlag(current.in_flight),
                          fired: requireVectorProofSqlFlag(current.fired),
                          firstPhysicalIds: current.first_ids_json === null ? null : (currentIds?.ids ?? null),
                          firstPayloadSha256: proofNullableSha256(current.first_payload_sha256),
                          returnedMutationIdSha256: proofNullableSha256(current.returned_mutation_sha256),
                          acceptedBeforeThrow: requireVectorProofSqlFlag(current.accepted_before_throw),
                          retryCount: requireVectorProofSqlInteger(current.retry_count, 0, 64),
                          retryIdsMatched: requireNullableVectorProofSqlFlag(current.retry_ids_match),
                          retryPayloadMatched: requireNullableVectorProofSqlFlag(current.retry_payload_match),
                          retryComplete: requireVectorProofSqlFlag(current.retry_complete),
                          gateOpen: requireVectorProofSqlFlag(current.gate_open),
                          gateDeadline: requireNullableVectorProofSqlInteger(current.gate_deadline),
                      }
                    : null,
                vectorId,
                mode
            );
            if (decision === "idempotent") return;
            this.ctx.storage.sql.exec(
                `INSERT INTO _chardb_vector_proof_fault
                   (singleton, vector_id, mode, armed, in_flight, fired, first_ids_json, first_payload_sha256,
                    returned_mutation_sha256, accepted_before_throw, retry_count, retry_ids_match,
                    retry_payload_match, retry_complete, gate_open, gate_deadline, updated_at)
                 VALUES (1, ?, ?, 1, 0, 0, NULL, NULL, NULL, 0, 0, NULL, NULL, 0, 0, NULL, ?)
                 ON CONFLICT(singleton) DO UPDATE SET
                   vector_id = excluded.vector_id,
                   mode = excluded.mode,
                   armed = 1,
                   in_flight = 0,
                   fired = 0,
                   first_ids_json = NULL,
                   first_payload_sha256 = NULL,
                   returned_mutation_sha256 = NULL,
                   accepted_before_throw = 0,
                   retry_count = 0,
                   retry_ids_match = NULL,
                   retry_payload_match = NULL,
                   retry_complete = 0,
                   gate_open = 0,
                   gate_deadline = NULL,
                   updated_at = excluded.updated_at`,
                vectorId,
                mode,
                Date.now()
            );
        });
        return Object.freeze({ armed: true, mode, vectorId });
    }

    async proofReleaseVectorGate(input: {
        readonly vectorId: string;
        readonly gateDeadline: number;
        readonly physicalIds: readonly string[];
        readonly payloadSha256: string;
    }): Promise<{ readonly released: true; readonly gateDeadline: number }> {
        const vectorId = exactVectorId(input.vectorId);
        if (!Number.isSafeInteger(input.gateDeadline) || input.gateDeadline <= 0) {
            throw new TypeError("proof vector gate release deadline is invalid");
        }
        const physicalIds = parsePhysicalIds(JSON.stringify(input.physicalIds));
        if (physicalIds.length === 0) throw new TypeError("proof vector gate release physical ids are invalid");
        const physicalIdScope = scopeVectorProofFaultPhysicalIds(
            JSON.stringify(physicalIds),
            vectorId,
            vectorId,
            parseCdbVectorizePhysicalId
        );
        if (!physicalIdScope.ok || !physicalIdScope.appliesToExpectedVector) {
            throw new TypeError("proof vector gate release changed logical ownership");
        }
        const physicalIdsJson = JSON.stringify(physicalIds);
        if (!/^[a-f0-9]{64}$/.test(input.payloadSha256)) {
            throw new TypeError("proof vector gate release payload hash is invalid");
        }
        const released = this.ctx.storage.transactionSync(() => {
            ensureProofFaultStore(this.ctx.storage);
            const now = Date.now();
            const fault = one<StoredProofFault>(
                this.ctx.storage,
                `SELECT vector_id, mode, armed, in_flight, fired, first_ids_json, first_payload_sha256,
                        returned_mutation_sha256, accepted_before_throw, retry_count, retry_ids_match,
                        retry_payload_match, retry_complete, gate_open, gate_deadline, updated_at
                 FROM _chardb_vector_proof_fault WHERE singleton = 1`
            );
            if (
                !fault ||
                exactVectorId(fault.vector_id ?? "") !== vectorId ||
                fault.mode !== "upsert_accept_then_throw" ||
                fault.armed !== 1 ||
                fault.in_flight !== 1 ||
                fault.fired !== 0 ||
                fault.gate_open !== 0 ||
                fault.gate_deadline === null ||
                fault.gate_deadline <= now ||
                fault.gate_deadline !== input.gateDeadline ||
                fault.first_ids_json !== physicalIdsJson ||
                fault.first_payload_sha256 !== input.payloadSha256 ||
                fault.returned_mutation_sha256 !== null ||
                fault.accepted_before_throw !== 0 ||
                fault.retry_count !== 0 ||
                fault.retry_ids_match !== null ||
                fault.retry_payload_match !== null ||
                fault.retry_complete !== 0
            ) {
                throw new TypeError("proof vector gate has no live held upsert claim");
            }
            this.ctx.storage.sql.exec(
                `UPDATE _chardb_vector_proof_fault SET gate_open = 1, updated_at = ?
                 WHERE singleton = 1 AND vector_id = ? AND armed = 1 AND in_flight = 1 AND fired = 0
                   AND gate_open = 0 AND gate_deadline = ? AND first_ids_json = ? AND first_payload_sha256 = ?
                   AND returned_mutation_sha256 IS NULL AND accepted_before_throw = 0 AND retry_count = 0
                   AND retry_ids_match IS NULL AND retry_payload_match IS NULL AND retry_complete = 0`,
                now,
                vectorId,
                input.gateDeadline,
                physicalIdsJson,
                input.payloadSha256
            );
            if (one<{ count: number }>(this.ctx.storage, "SELECT changes() AS count")?.count !== 1) {
                throw new TypeError("proof vector gate release raced another request");
            }
            return Object.freeze({
                released: true as const,
                gateDeadline: fault.gate_deadline,
                releasedAt: now,
                wakeAt: now + 1,
            });
        });
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm === null || currentAlarm <= released.releasedAt || released.wakeAt < currentAlarm) {
            await this.ctx.storage.setAlarm(released.wakeAt);
        }
        return Object.freeze({ released: true, gateDeadline: released.gateDeadline });
    }

    proofVectorIntent(input: {
        readonly action: "create" | "replace" | "delete";
        readonly organizationId: string;
        readonly id: string;
    }): {
        readonly vectorId: string;
        readonly action: "upsert" | "delete";
        readonly nextVersion: number;
        readonly physicalIds: readonly string[];
    } {
        const organizationId = exactOrganizationId(input.organizationId);
        const id = exactDocumentId(input.id);
        const action = exactIntentAction(input.action);
        if (vectorResources.length !== 1 || !vectorResources[0]) {
            throw new TypeError("proof requires exactly one vector resource");
        }
        const resourceId = cdbVectorResourceId(vectorResources[0]);
        const vectorId = cdbVectorLogicalId(resourceId, organizationId, id);
        const head = one<{
            organization_id: string;
            resource_id: string;
            row_pk: string;
            version: number;
            state: string;
        }>(
            this.ctx.storage,
            `SELECT organization_id, resource_id, row_pk, version, state
             FROM _chardb_vectors WHERE vector_id = ? LIMIT 1`,
            vectorId
        );
        if (
            head &&
            (head.organization_id !== organizationId || head.resource_id !== resourceId || head.row_pk !== id)
        ) {
            throw new TypeError("proof vector intent ownership drifted");
        }
        if (action === "create" && head) throw new TypeError("proof create intent requires an absent vector head");
        if (action !== "create" && (!head || head.state === "deleting")) {
            throw new TypeError(`proof ${action} intent requires a live vector head`);
        }
        const nextVersion = (head?.version ?? 0) + 1;
        if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) {
            throw new TypeError("proof vector intent version is invalid");
        }
        if (action !== "delete") {
            return Object.freeze({
                vectorId,
                action: "upsert",
                nextVersion,
                physicalIds: Object.freeze([cdbVectorizePhysicalId(vectorId, nextVersion)]),
            });
        }
        const attempts = this.ctx.storage.sql
            .exec<{ physical_version: number }>(
                `SELECT DISTINCT physical_version FROM _chardb_vector_attempts
                 WHERE vector_id = ? ORDER BY physical_version LIMIT 513`,
                vectorId
            )
            .toArray();
        if (attempts.length > 512) throw new TypeError("proof delete intent exceeds the physical-id ledger bound");
        const physicalIds = attempts.map(attempt => {
            if (!Number.isSafeInteger(attempt.physical_version) || attempt.physical_version < 1) {
                throw new TypeError("proof delete intent contains an invalid physical version");
            }
            return cdbVectorizePhysicalId(vectorId, attempt.physical_version);
        });
        return Object.freeze({ vectorId, action: "delete", nextVersion, physicalIds: Object.freeze(physicalIds) });
    }

    async proofVectorAdversary(input: {
        readonly action: "inspect" | "apply" | "restore";
        readonly organizationId: string;
        readonly id: string;
        readonly staleValues?: readonly number[];
        readonly currentValues?: readonly number[];
    }): Promise<{
        readonly action: "inspect" | "apply" | "restore";
        readonly vectorId: string;
        readonly stalePhysicalId: string;
        readonly currentPhysicalId: string;
        readonly upsertMutationIdSha256: string | null;
        readonly deleteMutationIdSha256: string | null;
    }> {
        const action = exactAdversaryAction(input.action);
        const organizationId = exactOrganizationId(input.organizationId);
        const id = exactDocumentId(input.id);
        if (vectorResources.length !== 1 || !vectorResources[0]) {
            throw new TypeError("proof requires exactly one vector resource");
        }
        ensureProofFaultStore(this.ctx.storage);
        const resource = vectorResources[0];
        const resourceId = cdbVectorResourceId(resource);
        const vectorId = cdbVectorLogicalId(resourceId, organizationId, id);
        const head = one<{
            organization_id: string;
            resource_id: string;
            row_pk: string;
            version: number;
            delivered_version: number;
            state: string;
        }>(
            this.ctx.storage,
            `SELECT organization_id, resource_id, row_pk, version, delivered_version, state
             FROM _chardb_vectors WHERE vector_id = ? LIMIT 1`,
            vectorId
        );
        if (
            !head ||
            head.organization_id !== organizationId ||
            head.resource_id !== resourceId ||
            head.row_pk !== id ||
            head.version !== 2 ||
            head.delivered_version !== 2 ||
            head.state !== "ready"
        ) {
            throw new TypeError("proof vector adversary requires the exact ready replacement head");
        }
        if (
            one<{ present: number }>(
                this.ctx.storage,
                "SELECT 1 AS present FROM _chardb_vector_outbox WHERE vector_id = ? LIMIT 1",
                vectorId
            )
        ) {
            throw new TypeError("proof vector adversary requires completed superseded cleanup");
        }
        const attempts = this.ctx.storage.sql
            .exec<{
                physical_version: number;
                visibility_confirmed: number;
                delete_confirmed: number;
            }>(
                `SELECT physical_version, visibility_confirmed, delete_confirmed
                 FROM _chardb_vector_attempts WHERE vector_id = ? ORDER BY physical_version`,
                vectorId
            )
            .toArray();
        if (
            attempts.length !== 1 ||
            attempts[0]?.physical_version !== 2 ||
            attempts[0]?.visibility_confirmed !== 1 ||
            attempts[0]?.delete_confirmed !== 0
        ) {
            throw new TypeError("proof vector adversary attempt ledger is not settled");
        }
        const stalePhysicalId = cdbVectorizePhysicalId(vectorId, 1);
        const currentPhysicalId = cdbVectorizePhysicalId(vectorId, 2);
        if (action === "inspect") {
            return Object.freeze({
                action,
                vectorId,
                stalePhysicalId,
                currentPhysicalId,
                upsertMutationIdSha256: null,
                deleteMutationIdSha256: null,
            });
        }
        const staleValues = exactProofVectorValues(input.staleValues);
        const currentValues = exactProofVectorValues(input.currentValues);
        const record = (physicalId: string, values: readonly number[]): CdbVectorizeRecord =>
            Object.freeze({
                id: physicalId,
                values,
                namespace: cdbVectorizeOrganizationNamespace(organizationId),
                metadata: Object.freeze({ cdb_resource: cdbVectorizeResourceFilter(resourceId) }),
            });
        const staleRecord = record(stalePhysicalId, staleValues);
        const currentRecord = record(currentPhysicalId, currentValues);
        for (const [physicalId, candidate] of [
            [stalePhysicalId, staleRecord],
            [currentPhysicalId, currentRecord],
        ] as const) {
            const accepted = one<Pick<StoredProofAcceptance, "payload_sha256">>(
                this.ctx.storage,
                `SELECT payload_sha256 FROM _chardb_vector_proof_acceptance
                 WHERE vector_id = ? AND physical_id = ? AND operation = 'upsert' LIMIT 1`,
                vectorId,
                physicalId
            );
            const payloadSha256 = await vectorProofSha256(
                vectorProofMutationEvidence("upsert", [candidate], parseCdbVectorizePhysicalId).canonicalPayload
            );
            if (!accepted || proofSha256(accepted.payload_sha256) !== payloadSha256) {
                throw new TypeError("proof vector adversary payload does not match accepted delivery evidence");
            }
        }
        const real = super.resolveVectorIndex(resource.binding);
        const upsertRecord = action === "apply" ? staleRecord : currentRecord;
        const deletePhysicalId = action === "apply" ? currentPhysicalId : stalePhysicalId;
        const upsertReceipt = await real.upsert([upsertRecord]);
        const upsertMutationIdSha256 = await vectorProofMutationIdHash(upsertReceipt);
        if (!upsertMutationIdSha256) {
            throw new TypeError("proof vector adversary upsert returned no bounded mutation id");
        }
        const deleteReceipt = await real.deleteByIds([deletePhysicalId]);
        const deleteMutationIdSha256 = await vectorProofMutationIdHash(deleteReceipt);
        if (!deleteMutationIdSha256) {
            throw new TypeError("proof vector adversary delete returned no bounded mutation id");
        }
        return Object.freeze({
            action,
            vectorId,
            stalePhysicalId,
            currentPhysicalId,
            upsertMutationIdSha256,
            deleteMutationIdSha256,
        });
    }

    async proofVectorState(vectorId: string): Promise<VectorProofStateRpcResult> {
        let diagnosticCode: VectorProofStateDiagnosticCode = "CDB_PROOF_VECTOR_STATE_INPUT_FAILED";
        try {
            const id = exactVectorId(vectorId);
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_FAULT_STORE_FAILED";
            const faultStoreColumns = assertProofFaultStore(this.ctx.storage);
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_HEAD_READ_FAILED";
            const head = one<{
                vector_id: string;
                organization_id: string;
                resource_id: string;
                row_pk: string;
                version: number;
                delivered_version: number;
                state: string;
            }>(
                this.ctx.storage,
                `SELECT vector_id, organization_id, resource_id, row_pk, version, delivered_version, state
             FROM _chardb_vectors WHERE vector_id = ? LIMIT 1`,
                id
            );
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_READ_FAILED";
            const outbox = one<{
                target_version: number;
                operation: string;
                phase: string;
                mutation_id: string | null;
                accepted_at: number | null;
                attempts: number;
                next_attempt_at: number;
                leased_until: number | null;
                lease_token: string | null;
                terminal_failure: number | bigint;
                last_error: string | null;
            }>(
                this.ctx.storage,
                `SELECT target_version, operation, phase, mutation_id, accepted_at, attempts,
                    next_attempt_at, leased_until, lease_token, terminal_failure, last_error
             FROM _chardb_vector_outbox WHERE vector_id = ? LIMIT 1`,
                id
            );
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ATTEMPTS_READ_FAILED";
            const attempts = this.ctx.storage.sql
                .exec<{
                    physical_version: number;
                    first_sent_at: number;
                    settle_after: number;
                    visibility_confirmed: number;
                    response_ambiguous: number;
                    delete_confirmed: number;
                }>(
                    `SELECT physical_version, first_sent_at, settle_after, visibility_confirmed,
                        response_ambiguous, delete_confirmed
                 FROM _chardb_vector_attempts
                 WHERE vector_id = ?
                 ORDER BY physical_version DESC
                 LIMIT 16`,
                    id
                )
                .toArray();
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ACCEPTANCES_READ_FAILED";
            const acceptances = this.ctx.storage.sql
                .exec<StoredProofAcceptance>(
                    `SELECT vector_id, physical_id, operation, payload_sha256, mutation_sha256, accepted_at
                 FROM _chardb_vector_proof_acceptance
                 WHERE vector_id = ?
                 ORDER BY accepted_at, physical_id, operation
                 LIMIT 32`,
                    id
                )
                .toArray();
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_FAULT_READ_FAILED";
            const fault = one<StoredProofFault>(
                this.ctx.storage,
                `SELECT ${faultStoreColumns.has("vector_id") ? "vector_id" : "NULL AS vector_id"},
                    mode, armed, in_flight, fired, first_ids_json, first_payload_sha256,
                    returned_mutation_sha256, accepted_before_throw, retry_count, retry_ids_match,
                    retry_payload_match, retry_complete,
                    ${faultStoreColumns.has("gate_open") ? "gate_open" : "0 AS gate_open"},
                    ${faultStoreColumns.has("gate_deadline") ? "gate_deadline" : "NULL AS gate_deadline"}, updated_at
                 FROM _chardb_vector_proof_fault WHERE singleton = 1`
            );
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_HEAD_READ_FAILED";
            const projectedHead = head
                ? (() => {
                      const version = requireVectorProofSqlInteger(head.version, 1);
                      const deliveredVersion = requireVectorProofSqlInteger(head.delivered_version, 0, version);
                      const organizationId = proofText(head.organization_id, 256);
                      const resourceId = proofText(head.resource_id, 68);
                      const rowPk = proofText(head.row_pk, 256);
                      if (
                          head.vector_id !== id ||
                          !PROOF_RESOURCE_ID.test(resourceId) ||
                          (head.state !== "pending" && head.state !== "ready" && head.state !== "deleting")
                      ) {
                          throw new TypeError("proof vector head is invalid");
                      }
                      return Object.freeze({
                          organizationId,
                          resourceId,
                          rowPk,
                          version,
                          deliveredVersion,
                          state: head.state,
                      });
                  })()
                : null;

            const terminalFailureResult = outbox ? parseVectorProofTerminalFlag(outbox.terminal_failure) : null;
            if (terminalFailureResult && !terminalFailureResult.ok) {
                return vectorProofStateFailure(terminalFailureResult.error.code);
            }
            const terminalFailure = terminalFailureResult?.value ?? null;
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_READ_FAILED";
            const projectedOutbox = outbox
                ? (() => {
                      diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_SCALARS_INVALID";
                      const targetVersion = requireVectorProofSqlInteger(outbox.target_version, 1);
                      const acceptedAt = requireNullableVectorProofSqlInteger(outbox.accepted_at);
                      const attemptCount = requireVectorProofSqlInteger(outbox.attempts);
                      const nextAttemptAt = requireVectorProofSqlInteger(outbox.next_attempt_at);
                      const leasedUntil = requireNullableVectorProofSqlInteger(outbox.leased_until);
                      const mutationId = proofNullableText(outbox.mutation_id, 128);
                      const leaseToken = proofNullableText(outbox.lease_token, 256);
                      const lastError = proofNullableText(outbox.last_error, 2_048);
                      if ((leasedUntil === null) !== (leaseToken === null)) {
                          diagnosticCode = "CDB_PROOF_VECTOR_STATE_LEASE_IDENTITY_INVALID";
                          throw new TypeError("proof vector outbox lease identity is invalid");
                      }
                      diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_OPERATION_PHASE_INVALID";
                      if (
                          (outbox.operation !== "upsert" && outbox.operation !== "delete") ||
                          (outbox.phase !== "submit" && outbox.phase !== "verify")
                      ) {
                          throw new TypeError("proof vector outbox operation or phase is invalid");
                      }
                      diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_PHASE_IDENTITY_INVALID";
                      if (
                          (outbox.phase === "submit" && (mutationId !== null || acceptedAt !== null)) ||
                          (outbox.phase === "verify" && (mutationId === null || acceptedAt === null))
                      ) {
                          throw new TypeError("proof vector outbox receipt identity is invalid");
                      }
                      diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_TERMINAL_SHAPE_INVALID";
                      if (
                          terminalFailure === 1 &&
                          (outbox.operation !== "delete" ||
                              leasedUntil !== null ||
                              leaseToken !== null ||
                              lastError !== CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR)
                      ) {
                          throw new TypeError("proof vector outbox terminal shape is invalid");
                      }
                      return Object.freeze({
                          targetVersion,
                          operation: outbox.operation,
                          phase: outbox.phase,
                          mutationId,
                          acceptedAt,
                          attempts: attemptCount,
                          nextAttemptAt,
                          leasedUntil,
                          leaseToken,
                          terminalFailure: terminalFailure === 1,
                          lastError,
                      });
                  })()
                : null;

            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ATTEMPTS_READ_FAILED";
            const projectedAttempts = Object.freeze(
                attempts.map(attempt => {
                    const physicalVersion = requireVectorProofSqlInteger(attempt.physical_version, 1);
                    const firstSentAt = requireVectorProofSqlInteger(attempt.first_sent_at);
                    const settleAfter = requireVectorProofSqlInteger(attempt.settle_after, firstSentAt);
                    return Object.freeze({
                        physicalVersion,
                        firstSentAt,
                        settleAfter,
                        visibilityConfirmed: requireVectorProofSqlFlag(attempt.visibility_confirmed),
                        responseAmbiguous: requireVectorProofSqlFlag(attempt.response_ambiguous),
                        deleteConfirmed: requireVectorProofSqlFlag(attempt.delete_confirmed),
                    });
                })
            );

            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ACCEPTANCES_READ_FAILED";
            const projectedAcceptances = [];
            for (const acceptance of acceptances) {
                const identity = validateVectorProofAcceptanceIdentity(
                    acceptance.physical_id,
                    acceptance.vector_id,
                    id,
                    parseCdbVectorizePhysicalId
                );
                if (!identity.ok) return vectorProofStateFailure(identity.error.code);
                if (acceptance.operation !== "upsert" && acceptance.operation !== "delete") {
                    throw new TypeError("proof acceptance operation is invalid");
                }
                projectedAcceptances.push(
                    Object.freeze({
                        operation: acceptance.operation,
                        physicalId: acceptance.physical_id,
                        payloadSha256: proofSha256(acceptance.payload_sha256),
                        mutationIdSha256: proofSha256(acceptance.mutation_sha256),
                        acceptedAt: requireVectorProofSqlInteger(acceptance.accepted_at),
                    })
                );
            }

            diagnosticCode = "CDB_PROOF_VECTOR_STATE_FAULT_READ_FAILED";
            const storedFaultOwnership = fault
                ? resolveVectorProofFaultPhysicalIds(fault.first_ids_json, fault.vector_id, parseCdbVectorizePhysicalId)
                : null;
            if (storedFaultOwnership && !storedFaultOwnership.ok) {
                return vectorProofStateFailure(storedFaultOwnership.error.code);
            }
            const storedFaultVectorId = storedFaultOwnership ? exactVectorId(storedFaultOwnership.vectorId) : null;
            const firstPhysicalIdsResult = fault
                ? scopeVectorProofFaultPhysicalIds(
                      fault.first_ids_json,
                      fault.vector_id,
                      id,
                      parseCdbVectorizePhysicalId
                  )
                : null;
            if (firstPhysicalIdsResult && !firstPhysicalIdsResult.ok) {
                return vectorProofStateFailure(firstPhysicalIdsResult.error.code);
            }
            const firstPhysicalIds = firstPhysicalIdsResult?.ids ?? null;
            const storedProjectedFault = fault
                ? (() => {
                      if (fault.mode !== "upsert_accept_then_throw" && fault.mode !== "delete_accept_then_throw") {
                          throw new TypeError("proof vector fault mode is invalid");
                      }
                      const armed = requireVectorProofSqlFlag(fault.armed);
                      const inFlight = requireVectorProofSqlFlag(fault.in_flight);
                      const fired = requireVectorProofSqlFlag(fault.fired);
                      if ((armed && fired) || (inFlight && !armed)) {
                          throw new TypeError("proof vector fault state is invalid");
                      }
                      return Object.freeze({
                          mode: fault.mode,
                          armed,
                          inFlight,
                          fired,
                          firstPhysicalIds,
                          firstPayloadSha256: proofNullableSha256(fault.first_payload_sha256),
                          returnedMutationIdSha256: proofNullableSha256(fault.returned_mutation_sha256),
                          acceptedBeforeThrow: requireVectorProofSqlFlag(fault.accepted_before_throw),
                          retryCount: requireVectorProofSqlInteger(fault.retry_count, 0, 64),
                          retryIdsMatched: requireNullableVectorProofSqlFlag(fault.retry_ids_match),
                          retryPayloadMatched: requireNullableVectorProofSqlFlag(fault.retry_payload_match),
                          retryComplete: requireVectorProofSqlFlag(fault.retry_complete),
                          gateOpen: requireVectorProofSqlFlag(fault.gate_open),
                          gateDeadline: requireNullableVectorProofSqlInteger(fault.gate_deadline),
                          updatedAt: requireVectorProofSqlInteger(fault.updated_at),
                      });
                  })()
                : null;
            const projectedFault = storedFaultVectorId === id ? storedProjectedFault : null;

            diagnosticCode = "CDB_PROOF_VECTOR_STATE_MUTATION_ID_HASH_FAILED";
            const outboxMutationIdSha256 = projectedOutbox?.mutationId
                ? await vectorProofSha256(projectedOutbox.mutationId)
                : null;
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_CLAIM_TOKEN_HASH_FAILED";
            const claimTokenSha256 = projectedOutbox?.leaseToken
                ? await vectorProofSha256(projectedOutbox.leaseToken)
                : null;
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_FAILED";
            const lastErrorHashResult = projectedOutbox?.lastError
                ? vectorProofSha256Result(projectedOutbox.lastError)
                : null;
            if (lastErrorHashResult && !lastErrorHashResult.ok) {
                const code =
                    lastErrorHashResult.reason === "input"
                        ? "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_INPUT_INVALID"
                        : lastErrorHashResult.reason === "digest"
                          ? "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_DIGEST_FAILED"
                          : lastErrorHashResult.reason === "output"
                            ? "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_OUTPUT_INVALID"
                            : "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_HEX_INVALID";
                return vectorProofStateFailure(code);
            }
            const lastErrorSha256 = lastErrorHashResult?.value ?? null;
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_LAST_ERROR_CLASSIFICATION_FAILED";
            const lastErrorClassification =
                projectedOutbox?.lastError === null || projectedOutbox?.lastError === undefined
                    ? null
                    : projectedOutbox.lastError === CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR
                      ? "delete_absence_unproven"
                      : "other";
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ALARM_READ_FAILED";
            const storedAlarm = await this.ctx.storage.getAlarm();
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_ALARM_TIMESTAMP_INVALID";
            const scheduledAlarmAt = requireNullableVectorProofSqlInteger(storedAlarm);
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_CLOCK_FAILED";
            const observedAt = requireVectorProofSqlInteger(Date.now());
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_STATE_ASSEMBLY_FAILED";
            const state = Object.freeze({
                vectorId: id,
                observedAt,
                scheduledAlarmAt,
                head: projectedHead,
                outbox: projectedOutbox
                    ? Object.freeze({
                          targetVersion: projectedOutbox.targetVersion,
                          operation: projectedOutbox.operation,
                          phase: projectedOutbox.phase,
                          mutationIdSha256: outboxMutationIdSha256,
                          acceptedAt: projectedOutbox.acceptedAt,
                          attempts: projectedOutbox.attempts,
                          nextAttemptAt: projectedOutbox.nextAttemptAt,
                          leased: projectedOutbox.leasedUntil !== null && projectedOutbox.leasedUntil > observedAt,
                          leasedUntil: projectedOutbox.leasedUntil,
                          claimTokenSha256,
                          terminalFailure: projectedOutbox.terminalFailure,
                          lastErrorClassification,
                          lastErrorSha256,
                      })
                    : null,
                attempts: projectedAttempts,
                acceptances: Object.freeze(projectedAcceptances),
                fault: projectedFault,
            });
            diagnosticCode = "CDB_PROOF_VECTOR_STATE_RESULT_WRAP_FAILED";
            return vectorProofStateSuccess(state);
        } catch {
            return vectorProofStateFailure(diagnosticCode);
        }
    }

    private async proofVectorMutation(
        operation: "upsert" | "delete",
        evidence: VectorProofMutationEvidence,
        send: () => Promise<unknown> | unknown
    ): Promise<unknown> {
        const payloadSha256 = await vectorProofSha256(evidence.canonicalPayload);
        const acceptedIds = parsePhysicalIds(evidence.idsJson);
        const firstAcceptedId = parseCdbVectorizePhysicalId(acceptedIds[0] ?? "");
        if (!firstAcceptedId) throw new TypeError("proof mutation has no logical vector ownership");
        const evidenceVectorId = exactVectorId(firstAcceptedId.vectorId);
        const evidenceScope = scopeVectorProofFaultPhysicalIds(
            evidence.idsJson,
            evidenceVectorId,
            evidenceVectorId,
            parseCdbVectorizePhysicalId
        );
        if (!evidenceScope.ok || !evidenceScope.appliesToExpectedVector) {
            throw new TypeError("proof mutation changed logical vector ownership");
        }
        const decision = this.ctx.storage.transactionSync<"blocked" | "fault" | "resumed-fault" | "retry" | "pass">(
            () => {
                ensureProofFaultStore(this.ctx.storage);
                const fault = one<StoredProofFault>(
                    this.ctx.storage,
                    `SELECT vector_id, mode, armed, in_flight, fired, first_ids_json, first_payload_sha256,
                        returned_mutation_sha256, accepted_before_throw, retry_count, retry_ids_match,
                        retry_payload_match, retry_complete, gate_open, gate_deadline, updated_at
                 FROM _chardb_vector_proof_fault WHERE singleton = 1`
                );
                if (!fault) return "pass";
                const faultVectorId = exactVectorId(fault.vector_id ?? "");
                if (vectorProofFaultOperation(fault.mode) !== operation) return "pass";
                if (faultVectorId !== evidenceVectorId) return "pass";
                if (fault.armed === 1 && fault.in_flight === 1 && fault.fired === 0) {
                    if (operation === "upsert" && fault.gate_open === 1) {
                        if (fault.first_ids_json !== evidence.idsJson || fault.first_payload_sha256 !== payloadSha256) {
                            throw new TypeError("released proof vector gate changed its first mutation evidence");
                        }
                        return "resumed-fault";
                    }
                    const now = Date.now();
                    if (fault.gate_deadline !== null && now >= fault.gate_deadline) {
                        this.ctx.storage.sql.exec(
                            `UPDATE _chardb_vector_proof_fault
                         SET armed = 0, in_flight = 0, gate_open = 0, gate_deadline = NULL, updated_at = ?
                         WHERE singleton = 1 AND vector_id = ? AND armed = 1 AND in_flight = 1 AND fired = 0`,
                            now,
                            evidenceVectorId
                        );
                    }
                    return "blocked";
                }
                if (fault.armed === 1 && fault.in_flight === 0 && fault.fired === 0) {
                    const now = Date.now();
                    const gateDeadline = operation === "upsert" ? now + PROOF_UPSERT_GATE_TIMEOUT_MS : null;
                    this.ctx.storage.sql.exec(
                        `UPDATE _chardb_vector_proof_fault
                     SET in_flight = 1, first_ids_json = ?, first_payload_sha256 = ?,
                         gate_open = ?, gate_deadline = ?, updated_at = ?
                     WHERE singleton = 1 AND vector_id = ? AND armed = 1 AND in_flight = 0 AND fired = 0`,
                        evidence.idsJson,
                        payloadSha256,
                        operation === "upsert" ? 0 : 1,
                        gateDeadline,
                        now,
                        evidenceVectorId
                    );
                    return "fault";
                }
                if (fault.fired === 1 && fault.retry_complete === 0 && fault.retry_count < 64) {
                    const idsMatch = fault.first_ids_json === evidence.idsJson ? 1 : 0;
                    const payloadMatch = fault.first_payload_sha256 === payloadSha256 ? 1 : 0;
                    this.ctx.storage.sql.exec(
                        `UPDATE _chardb_vector_proof_fault
                     SET retry_count = retry_count + 1,
                         retry_ids_match = CASE
                           WHEN retry_ids_match IS NULL THEN ?
                           WHEN retry_ids_match = 1 AND ? = 1 THEN 1
                           ELSE 0
                         END,
                         retry_payload_match = CASE
                           WHEN retry_payload_match IS NULL THEN ?
                           WHEN retry_payload_match = 1 AND ? = 1 THEN 1
                           ELSE 0
                         END,
                         updated_at = ?
                     WHERE singleton = 1 AND vector_id = ? AND fired = 1 AND retry_complete = 0`,
                        idsMatch,
                        idsMatch,
                        payloadMatch,
                        payloadMatch,
                        Date.now(),
                        evidenceVectorId
                    );
                    return "retry";
                }
                return "pass";
            }
        );

        let receipt: unknown;
        try {
            if (decision === "blocked")
                throw new TypeError("proof vector gate blocked a retry after losing its holder");
            if (decision === "fault" && operation === "upsert") {
                await this.waitForProofVectorGate(evidenceVectorId);
            }
            receipt = await send();
        } catch (error) {
            if (decision === "fault") {
                this.ctx.storage.transactionSync(() => {
                    this.ctx.storage.sql.exec(
                        `UPDATE _chardb_vector_proof_fault
                         SET armed = 0, in_flight = 0, gate_open = 0, gate_deadline = NULL, updated_at = ?
                         WHERE singleton = 1 AND vector_id = ? AND armed = 1 AND in_flight = 1 AND fired = 0`,
                        Date.now(),
                        evidenceVectorId
                    );
                });
            }
            throw error;
        }

        const receiptSha256 = await vectorProofMutationIdHash(receipt);
        if (!receiptSha256) throw new TypeError("Vectorize proof receipt has no bounded mutation id");
        const acceptedAt = Date.now();
        this.ctx.storage.transactionSync(() => {
            for (const physicalId of acceptedIds) {
                const physical = parseCdbVectorizePhysicalId(physicalId);
                if (!physical) throw new TypeError("proof acceptance contains an invalid physical id");
                this.ctx.storage.sql.exec(
                    `INSERT OR IGNORE INTO _chardb_vector_proof_acceptance
                       (vector_id, physical_id, operation, payload_sha256, mutation_sha256, accepted_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    physical.vectorId,
                    physicalId,
                    operation,
                    payloadSha256,
                    receiptSha256,
                    acceptedAt
                );
                const stored = one<StoredProofAcceptance>(
                    this.ctx.storage,
                    `SELECT vector_id, physical_id, operation, payload_sha256, mutation_sha256, accepted_at
                     FROM _chardb_vector_proof_acceptance WHERE physical_id = ? AND operation = ? LIMIT 1`,
                    physicalId,
                    operation
                );
                const storedAcceptedAt = stored ? requireVectorProofSqlInteger(stored.accepted_at) : null;
                if (
                    !stored ||
                    stored.vector_id !== physical.vectorId ||
                    stored.physical_id !== physicalId ||
                    stored.operation !== operation ||
                    stored.payload_sha256 !== payloadSha256 ||
                    proofSha256(stored.mutation_sha256) !== stored.mutation_sha256 ||
                    storedAcceptedAt === null
                ) {
                    throw new TypeError("stored proof acceptance does not match its accepted mutation");
                }
            }
        });

        if (decision === "fault" || decision === "resumed-fault") {
            this.ctx.storage.transactionSync(() => {
                this.ctx.storage.sql.exec(
                    `UPDATE _chardb_vector_proof_fault
                     SET armed = 0, in_flight = 0, fired = 1, returned_mutation_sha256 = ?,
                         accepted_before_throw = 1, gate_open = 0, gate_deadline = NULL, updated_at = ?
                     WHERE singleton = 1 AND vector_id = ? AND armed = 1 AND in_flight = 1 AND fired = 0`,
                    receiptSha256,
                    Date.now(),
                    evidenceVectorId
                );
            });
            throw new Error("intentional Vectorize proof post-acceptance fault");
        }
        if (decision === "retry") {
            this.ctx.storage.transactionSync(() => {
                this.ctx.storage.sql.exec(
                    `UPDATE _chardb_vector_proof_fault
                     SET retry_complete = 1, updated_at = ?
                     WHERE singleton = 1 AND vector_id = ? AND fired = 1 AND retry_complete = 0`,
                    Date.now(),
                    evidenceVectorId
                );
            });
        }
        return receipt;
    }

    private async waitForProofVectorGate(vectorId: string): Promise<void> {
        for (let turn = 0; turn <= Math.ceil(PROOF_UPSERT_GATE_TIMEOUT_MS / PROOF_UPSERT_GATE_POLL_MS); turn++) {
            const fault = one<
                Pick<StoredProofFault, "vector_id" | "armed" | "in_flight" | "fired" | "gate_open" | "gate_deadline">
            >(
                this.ctx.storage,
                `SELECT vector_id, armed, in_flight, fired, gate_open, gate_deadline
                 FROM _chardb_vector_proof_fault WHERE singleton = 1`
            );
            if (
                !fault ||
                exactVectorId(fault.vector_id ?? "") !== vectorId ||
                fault.armed !== 1 ||
                fault.in_flight !== 1 ||
                fault.fired !== 0
            ) {
                throw new TypeError("proof vector gate lost its held claim");
            }
            if (fault.gate_open === 1) return;
            if (fault.gate_deadline === null || Date.now() >= fault.gate_deadline) {
                throw new TypeError("proof vector gate timed out before Vectorize send");
            }
            await new Promise(resolve => setTimeout(resolve, PROOF_UPSERT_GATE_POLL_MS));
        }
        throw new TypeError("proof vector gate exceeded its bounded wait");
    }
}

export default app;
export const { DB, Catalog, Gateway, Resharder } = app;
