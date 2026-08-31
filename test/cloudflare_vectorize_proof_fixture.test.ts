import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cdbVectorizePhysicalId, parseCdbVectorizePhysicalId } from "../src/server/do/cdb-vectorize-wire.ts";
import {
    VECTOR_PROOF_STATE_DIAGNOSTIC_CODES,
    assertVectorProofSearchAuditSequence,
    normalizeVectorProofSqlInteger,
    normalizeVectorProofTerminalFlag,
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
} from "./fixtures/cloudflare-vectorize-proof/src/vector-fault-evidence.ts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "cloudflare-vectorize-proof");
const ROOT = path.join(import.meta.dir, "..");
const PROOF_VECTOR_ID = `vec1_${"ab".repeat(32)}`;
const PROOF_PHYSICAL_ID = cdbVectorizePhysicalId(PROOF_VECTOR_ID, 1);
const INTERNAL_DURABLE_OBJECT_BINDINGS = [
    { name: "CDB_CATALOG", class_name: "Catalog" },
    { name: "CDB_SHARD", class_name: "Cdb" },
    { name: "CDB_GATEWAY", class_name: "Gateway" },
    { name: "CDB_RESHARD", class_name: "Resharder" },
];

describe("candidate-bound Cloudflare Vectorize proof fixture", () => {
    test("correlates one public search to exactly one provider invocation", () => {
        expect(assertVectorProofSearchAuditSequence(7, 8, 8)).toBe(8);
        expect(() => assertVectorProofSearchAuditSequence(7, 9, 8)).toThrow("one exact provider invocation");
        expect(() => assertVectorProofSearchAuditSequence(7, 9, 9)).toThrow("one exact provider invocation");
        expect(() => assertVectorProofSearchAuditSequence(7, 8, 7)).toThrow("one exact provider invocation");
    });

    test("declares one exact Vectorize binding in TOML without storing proof secrets", async () => {
        const text = await readFile(path.join(FIXTURE, "wrangler.template.toml"), "utf8");
        const config = Bun.TOML.parse(text) as Record<string, unknown>;
        expect(config).toMatchObject({
            main: "src/worker.ts",
            compatibility_date: "2026-08-27",
            durable_objects: { bindings: INTERNAL_DURABLE_OBJECT_BINDINGS },
            vectorize: [{ binding: "CDB_PROOF_VECTORS", index_name: "__INDEX_NAME__", remote: true }],
            vars: { CDB_RELEASE_SHA256: "__RELEASE_SHA256__" },
        });
        expect(config).not.toHaveProperty("r2_buckets");
        expect(config).not.toHaveProperty("vars.CDB_ADMIN_TOKEN");
        expect(config).not.toHaveProperty("vars.CDB_PROOF_RUN_ID");
        expect(text).not.toMatch(/CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|CF_API_TOKEN|BEGIN (?:RSA |EC )?PRIVATE KEY/);
    });

    test("keeps Better Auth separate and defines one organization-owned 32-dim cosine vector", async () => {
        const [auth, schema, migrations] = await Promise.all([
            readFile(path.join(FIXTURE, "src", "auth.ts"), "utf8"),
            readFile(path.join(FIXTURE, "src", "schema.ts"), "utf8"),
            readFile(path.join(FIXTURE, "src", "migrations.ts"), "utf8"),
        ]);
        expect(auth).toContain('from "better-auth/plugins/organization"');
        expect(auth).toContain("organization()");
        expect(schema).toContain('import { auth } from "./auth.ts"');
        expect(schema).toContain("const { cdbTable } = forOrg(auth);");
        expect(schema.match(/\bvector\(/g)).toHaveLength(1);
        expect(schema).toContain("dim: 32");
        expect(schema).toContain('binding: "CDB_PROOF_VECTORS"');
        expect(schema).toContain('metric: "cosine"');
        expect(schema).toContain('read: { exclude: ["embedding"] }');
        expect(schema).not.toMatch(/forUser|forGlobal|\bfile\(/);
        expect(migrations).toContain('import { auth } from "./auth.ts"');
        expect(migrations).toContain("defineSchemaBaseline");
    });

    test("registers create, replace, delete, and query operations with organization placement", async () => {
        const api = await readFile(path.join(FIXTURE, "src", "api.ts"), "utf8");
        for (const operation of [
            "createVectorDocument",
            "replaceVectorDocument",
            "deleteVectorDocument",
            "listVectorDocuments",
            "searchVectorDocuments",
        ]) {
            expect(api).toContain(`export const ${operation}`);
        }
        expect(api.match(/authority: "organization"/g)).toHaveLength(3);
        expect(api.match(/partitionKey: "organizationId"/g)).toHaveLength(3);
        expect(api.match(/ctx\.vector\.set\(/g)).toHaveLength(2);
        expect(api.match(/ctx\.vector\.delete\(/g)).toHaveLength(1);
        expect(api).toContain("searchVector(vectorDocuments.embedding, args)");
    });

    test("imports only the installed candidate bridge and keeps proof routes authenticated", async () => {
        const [bridge, worker, faultEvidence] = await Promise.all([
            readFile(path.join(FIXTURE, "src", "vector-proof.ts"), "utf8"),
            readFile(path.join(FIXTURE, "src", "worker.ts"), "utf8"),
            readFile(path.join(FIXTURE, "src", "vector-fault-evidence.ts"), "utf8"),
        ]);
        expect(bridge).toContain('from "../node_modules/@chardb/core/dist/internal/vector-proof.mjs"');
        for (const helper of [
            "cdbVectorLogicalId",
            "cdbVectorResourceId",
            "cdbVectorizePhysicalId",
            "parseCdbVectorizePhysicalId",
        ]) {
            expect(bridge).toContain(helper);
            expect(worker).toContain(helper);
        }
        expect(bridge).not.toMatch(/\.\.\/\.\.\/\.\.\/.*src\//);
        expect(worker).toContain('from "./vector-proof.ts"');
        expect(worker).toContain('app.post("/api/vector-search"');
        expect(worker).toContain("api.searchVectorDocuments");
        expect(worker).toContain('app.post("/proof/add-member"');
        expect(worker).toContain('app.post("/proof/vector-fault/arm"');
        expect(worker).toContain("vectorId: exactVectorId(body.vectorId)");
        expect(worker).toContain('app.post("/proof/vector-fault/release"');
        expect(worker).toContain("readonly vectorId: string");
        expect(worker).toContain("vector_id                    TEXT NOT NULL");
        expect(worker).toContain("vector_id = excluded.vector_id");
        expect(worker).toContain("legacy proof vector fault has no trustworthy logical owner");
        expect(worker).toContain("WHERE singleton = 1 AND vector_id IS NULL");
        expect(worker).toContain('faultStoreColumns.has("vector_id") ? "vector_id" : "NULL AS vector_id"');
        expect(worker).toContain('faultStoreColumns.has("gate_open") ? "gate_open" : "0 AS gate_open"');
        expect(worker).toContain('if (faultVectorId !== evidenceVectorId) return "pass"');
        expect(worker).toContain("storedFaultVectorId === id ? storedProjectedFault : null");
        expect(worker).not.toContain("firstPhysicalIdsResult.ids.length > 0");
        expect(worker).toContain("gateDeadline: body.gateDeadline");
        expect(worker).toContain("physicalIds: body.physicalIds");
        expect(worker).toContain("payloadSha256: body.payloadSha256");
        expect(worker).toContain('app.get("/proof/vector-intent"');
        expect(worker).toContain('app.post("/proof/vector-descriptor"');
        expect(worker).toContain('app.post("/proof/vector-adversary"');
        expect(worker).toContain('app.post("/proof/vector-adversary/query"');
        expect(worker).toContain('app.post("/proof/vector-search-audit"');
        expect(worker).toContain("protected override resolveVectorSearchIndex");
        expect(worker).toContain("assertVectorProofSearchAuditSequence(afterSequence, latestSequence, row.sequence)");
        expect(worker).toContain("return receipt;");
        expect(worker).toContain('app.get("/proof/vector-state"');
        expect(worker).toContain('vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_ROUTE_FAILED")');
        expect(worker).toContain('vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RPC_FAILED")');
        expect(worker).toContain('vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RPC_RESULT_INVALID")');
        expect(worker).toContain("parseVectorProofStateRpcResult(raw)");
        const resultParserOffset = worker.indexOf("parseVectorProofStateRpcResult(raw)");
        const responseTryOffset = worker.indexOf("try {", resultParserOffset);
        const responseJsonOffset = worker.indexOf(
            "return result.ok ? c.json(result.state) : c.json(result, 500)",
            responseTryOffset
        );
        const responseFailureOffset = worker.indexOf(
            'vectorProofStateFailure("CDB_PROOF_VECTOR_STATE_RESPONSE_JSON_FAILED")',
            responseJsonOffset
        );
        expect(resultParserOffset).toBeGreaterThan(-1);
        expect(responseTryOffset).toBeGreaterThan(resultParserOffset);
        expect(responseJsonOffset).toBeGreaterThan(responseTryOffset);
        expect(responseFailureOffset).toBeGreaterThan(responseJsonOffset);
        expect(worker).not.toContain("/proof/vector-maintain");
        expect(worker).not.toContain("proofMaintainVectorDelivery");
        expect(worker).toContain("catalog.route(Number(vshardOf([owner])))");
        expect(worker).toContain("protected override resolveVectorIndex");
        expect(worker).toContain("getByIds: (ids: readonly string[]) => real.getByIds(ids)");
        expect(worker).toContain('throw new TypeError("Vectorize proof requires the V2 describe capability")');
        expect(worker).toContain("return describe.call(real)");
        expect(worker).toContain("receipt = await send()");
        expect(worker.indexOf("first_ids_json = ?")).toBeLessThan(worker.indexOf("receipt = await send()"));
        expect(worker.indexOf("receipt = await send()")).toBeLessThan(
            worker.indexOf('throw new Error("intentional Vectorize proof post-acceptance fault")')
        );
        expect(worker).toContain("CREATE TABLE IF NOT EXISTS _chardb_vector_proof_fault");
        expect(worker).toContain("CREATE TABLE IF NOT EXISTS _chardb_vector_proof_acceptance");
        expect(worker).toContain("INSERT OR IGNORE INTO _chardb_vector_proof_acceptance");
        expect(worker).toContain("Vectorize proof receipt has no bounded mutation id");
        expect(worker).toContain("mutationIdSha256: proofSha256(acceptance.mutation_sha256)");
        expect(worker).toContain("terminal_failure, last_error");
        expect(worker).toContain("assertProofFaultStore(this.ctx.storage)");
        expect(worker).not.toMatch(/proofVectorState[\s\S]{0,300}ensureProofFaultStore\(this\.ctx\.storage\)/);
        for (const code of VECTOR_PROOF_STATE_DIAGNOSTIC_CODES.slice(3)) {
            expect(`${worker}\n${faultEvidence}`).toContain(`"${code}"`);
        }
        expect(worker).toContain("lastErrorClassification");
        expect(worker).toContain('"delete_absence_unproven"');
        expect(worker).toContain("settlementConfiguredMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS");
        expect(worker).toContain("resourceFilter: cdbVectorizeResourceFilter(resourceId)");
        expect(worker).toContain("proof vector adversary requires completed superseded cleanup");
        expect(worker).toContain("attempts.length !== 1");
        expect(worker).toContain("attempts[0]?.physical_version !== 2");
        expect(worker).not.toContain("attempts.length !== 2");
        expect(worker).toContain("proof vector adversary payload does not match accepted delivery evidence");
        expect(worker).toContain("const real = super.resolveVectorIndex(resource.binding)");
        expect(worker).toContain("returnValues: false");
        expect(worker).toContain('returnMetadata: "none"');
        expect(worker).toContain("return c.json({ ...inspected, matches: projected })");
        expect(worker).toContain("namespaceIds: organizationIds.map(cdbVectorizeOrganizationNamespace)");
        expect(worker).toContain("retry_ids_match");
        expect(worker).toContain("retry_payload_match");
        expect(worker).toContain("accepted_before_throw");
        expect(worker).toContain("LIMIT 16");
        expect(worker).not.toContain("await this.alarm()");
        expect(worker).toContain("returned_mutation_sha256");
        expect(worker).toContain("AND first_ids_json = ? AND first_payload_sha256 = ?");
        expect(worker).toContain("AND returned_mutation_sha256 IS NULL AND accepted_before_throw = 0");
        expect(worker).toContain("AND retry_ids_match IS NULL AND retry_payload_match IS NULL AND retry_complete = 0");
        expect(worker).toContain("currentAlarm <= released.releasedAt");
        expect(worker).toContain("await this.ctx.storage.setAlarm(released.wakeAt)");
        expect(worker).toContain("claimTokenSha256");
        expect(worker).toContain("leasedUntil");
        expect(worker).toContain("requireVectorProofSqlInteger(head.version, 1)");
        expect(worker).toContain("requireVectorProofSqlFlag(attempt.visibility_confirmed)");
        expect(worker).toContain("requireNullableVectorProofSqlFlag(fault.retry_ids_match)");
        expect(worker).toContain("requireVectorProofSqlInteger(stored.accepted_at)");
        expect(worker).toContain("proofNullableText(outbox.mutation_id, 128)");
        const projectedOutboxStart = worker.indexOf("const projectedOutbox");
        const outboxScalarDiagnostic = worker.indexOf(
            'diagnosticCode = "CDB_PROOF_VECTOR_STATE_OUTBOX_SCALARS_INVALID"',
            projectedOutboxStart
        );
        for (const expression of [
            "outbox.target_version",
            "outbox.accepted_at",
            "outbox.attempts",
            "outbox.next_attempt_at",
            "outbox.leased_until",
            "outbox.mutation_id",
            "outbox.lease_token",
            "outbox.last_error",
        ]) {
            expect(outboxScalarDiagnostic).toBeLessThan(worker.indexOf(expression, projectedOutboxStart));
        }
        for (const code of [
            "CDB_PROOF_VECTOR_STATE_OUTBOX_OPERATION_PHASE_INVALID",
            "CDB_PROOF_VECTOR_STATE_OUTBOX_PHASE_IDENTITY_INVALID",
            "CDB_PROOF_VECTOR_STATE_LEASE_IDENTITY_INVALID",
            "CDB_PROOF_VECTOR_STATE_OUTBOX_TERMINAL_SHAPE_INVALID",
        ]) {
            expect(worker).toContain(`diagnosticCode = "${code}"`);
        }
        expect(worker.indexOf('diagnosticCode = "CDB_PROOF_VECTOR_STATE_MUTATION_ID_HASH_FAILED"')).toBeLessThan(
            worker.indexOf("await vectorProofSha256(projectedOutbox.mutationId)")
        );
        expect(worker.indexOf('diagnosticCode = "CDB_PROOF_VECTOR_STATE_CLAIM_TOKEN_HASH_FAILED"')).toBeLessThan(
            worker.indexOf("await vectorProofSha256(projectedOutbox.leaseToken)")
        );
        expect(worker.indexOf('diagnosticCode = "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_FAILED"')).toBeLessThan(
            worker.indexOf("vectorProofSha256Result(projectedOutbox.lastError)")
        );
        for (const [code, operation] of [
            ["CDB_PROOF_VECTOR_STATE_LAST_ERROR_CLASSIFICATION_FAILED", "const lastErrorClassification"],
            ["CDB_PROOF_VECTOR_STATE_ALARM_READ_FAILED", "const storedAlarm = await this.ctx.storage.getAlarm()"],
            ["CDB_PROOF_VECTOR_STATE_ALARM_TIMESTAMP_INVALID", "const scheduledAlarmAt"],
            ["CDB_PROOF_VECTOR_STATE_CLOCK_FAILED", "const observedAt = requireVectorProofSqlInteger(Date.now())"],
            ["CDB_PROOF_VECTOR_STATE_STATE_ASSEMBLY_FAILED", "const state = Object.freeze("],
            ["CDB_PROOF_VECTOR_STATE_RESULT_WRAP_FAILED", "return vectorProofStateSuccess(state)"],
        ] as const) {
            const operationOffset = worker.indexOf(operation);
            const diagnosticOffset = worker.lastIndexOf(`diagnosticCode = "${code}"`, operationOffset);
            expect(diagnosticOffset).toBeGreaterThan(-1);
            expect(diagnosticOffset).toBeLessThan(operationOffset);
        }
        expect(worker).not.toContain("Number(stored.accepted_at)");
        expect(worker).not.toMatch(/vectorProofSha256\(outbox\?\./);
        expect(worker).toContain("PROOF_UPSERT_GATE_TIMEOUT_MS = 10 * 60_000");
        expect(worker).toContain("proof vector gate timed out before Vectorize send");
        expect(worker).toContain("fault.gate_open === 1");
        expect(worker).toContain('return "resumed-fault"');
        expect(worker).toContain("released proof vector gate changed its first mutation evidence");
        expect(worker.indexOf("fault.gate_open === 1")).toBeLessThan(worker.lastIndexOf("fault.gate_deadline"));
        expect(worker).toContain('operation === "upsert" ? 0 : 1');
        expect(worker).toContain('gateDeadline = operation === "upsert"');
        expect(worker).toContain("fault.gate_deadline <= now");
        expect(worker.indexOf("await this.waitForProofVectorGate(evidenceVectorId)")).toBeGreaterThan(-1);
        expect(worker.indexOf("await this.waitForProofVectorGate(evidenceVectorId)")).toBeLessThan(
            worker.indexOf("receipt = await send()")
        );
        expect(worker).not.toMatch(/SET leased_until|leased_until\s*=\s*leased_until\s*\+/);
        expect(worker).not.toContain("stableHashHex");
        expect(worker).not.toContain("returned_mutation_id");
        expect(worker).not.toMatch(/network loss|durable object eviction|DO eviction/i);
        expect(worker).toContain("left.length > 0 && right.length > 0");
        expect(worker).toContain("runId.length > 0");
        expect(worker).toContain("await proofAuthorized(c.req, env)");
        expect(worker).toContain('return c.json({ error: "not found" }, 404)');
        expect(worker).not.toMatch(/console\.(?:log|info|debug).*TOKEN|CLOUDFLARE_API_TOKEN|CF_API_TOKEN/);
    });

    test("hashes canonical bounded mutation evidence without retaining raw mutation ids", async () => {
        const first = vectorProofMutationEvidence(
            "upsert",
            [
                {
                    id: PROOF_PHYSICAL_ID,
                    namespace: "o1_organization",
                    values: [0.25, -0.5, 1],
                    metadata: { z: true, a: "resource" },
                },
            ],
            parseCdbVectorizePhysicalId
        );
        const reordered = vectorProofMutationEvidence(
            "upsert",
            [
                {
                    id: PROOF_PHYSICAL_ID,
                    namespace: "o1_organization",
                    values: [0.25, -0.5, 1],
                    metadata: { a: "resource", z: true },
                },
            ],
            parseCdbVectorizePhysicalId
        );
        expect(first.ids).toEqual([PROOF_PHYSICAL_ID]);
        expect(first.canonicalPayload).toBe(reordered.canonicalPayload);
        const emptyDigest = vectorProofSha256("");
        expect(emptyDigest).toBeInstanceOf(Promise);
        expect(await emptyDigest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(await vectorProofSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(vectorProofSha256Result(false)).toEqual({ ok: false, reason: "input" });
        expect(vectorProofSha256Result("x".repeat(64 * 1_024 + 1))).toEqual({ ok: false, reason: "input" });
        expect(
            vectorProofSha256Result("abc", () => {
                throw new Error("digest unavailable");
            })
        ).toEqual({ ok: false, reason: "digest" });
        expect(vectorProofSha256Result("abc", () => new Uint8Array(31))).toEqual({
            ok: false,
            reason: "output",
        });
        expect(vectorProofSha256Result("abc", () => new ArrayBuffer(32))).toEqual({
            ok: false,
            reason: "output",
        });
        expect(
            vectorProofSha256Result(
                "abc",
                () => new Uint8Array(32),
                () => {
                    throw new Error("hex unavailable");
                }
            )
        ).toEqual({ ok: false, reason: "hex" });
        expect(
            vectorProofSha256Result(
                "abc",
                () => new Uint8Array(32),
                () => "A".repeat(64)
            )
        ).toEqual({ ok: false, reason: "hex" });
        expect(await vectorProofSha256(first.canonicalPayload)).toMatch(/^[a-f0-9]{64}$/);
        await expect(vectorProofSha256(false)).rejects.toThrow("proof hash input is invalid");
        await expect(vectorProofSha256("x".repeat(64 * 1_024 + 1))).rejects.toThrow("proof hash input is invalid");
        const mutationId = "cloudflare-mutation-id-that-must-not-be-stored";
        const mutationHash = await vectorProofMutationIdHash({ mutationId });
        expect(mutationHash).toMatch(/^[a-f0-9]{64}$/);
        expect(mutationHash).not.toContain(mutationId);

        let getterCalls = 0;
        const accessor = Object.defineProperty({}, "mutationId", {
            get() {
                getterCalls++;
                return mutationId;
            },
        });
        expect(await vectorProofMutationIdHash(accessor)).toBeNull();
        expect(getterCalls).toBe(0);
        expect(vectorProofFaultOperation("delete_accept_then_throw")).toBe("delete");
        expect(() =>
            vectorProofMutationEvidence("delete", [PROOF_PHYSICAL_ID, PROOF_PHYSICAL_ID], parseCdbVectorizePhysicalId)
        ).toThrow(/physical ids/);
        expect(() =>
            vectorProofMutationEvidence("delete", ["p1_not-a-production-identity"], parseCdbVectorizePhysicalId)
        ).toThrow(/physical ids/);
    });

    test("keeps proof-state RPC diagnostics closed, exact, and free of exception text", () => {
        expect(VECTOR_PROOF_STATE_DIAGNOSTIC_CODES).toHaveLength(42);
        for (const code of VECTOR_PROOF_STATE_DIAGNOSTIC_CODES) {
            const failure = vectorProofStateFailure(code);
            expect(parseVectorProofStateRpcResult(failure)).toEqual({ ok: false, error: { code } });
            expect(JSON.stringify(failure)).toBe(`{"ok":false,"error":{"code":"${code}"}}`);
        }
        const state = Object.freeze({ vectorId: "safe-vector-state" });
        expect(parseVectorProofStateRpcResult(vectorProofStateSuccess(state))).toEqual({ ok: true, state });
        expect(() => vectorProofStateFailure("secret-bearing-runtime-message" as never)).toThrow(
            "proof vector state diagnostic code is invalid"
        );
        expect(() =>
            parseVectorProofStateRpcResult({
                ok: false,
                error: { code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED", detail: "must-not-pass" },
            })
        ).toThrow("proof vector state RPC error fields are invalid");
        let getterCalls = 0;
        const accessor = Object.defineProperty({ ok: true }, "state", {
            enumerable: true,
            get() {
                getterCalls++;
                return "must-not-read";
            },
        });
        expect(() => parseVectorProofStateRpcResult(accessor)).toThrow(
            "proof vector state RPC result fields are invalid"
        );
        expect(getterCalls).toBe(0);
    });

    test("classifies stored fault physical-id failures without exposing their contents", () => {
        expect(parseVectorProofPhysicalIds(null, parseCdbVectorizePhysicalId)).toEqual({ ok: true, ids: [] });
        expect(parseVectorProofPhysicalIds(JSON.stringify([PROOF_PHYSICAL_ID]), parseCdbVectorizePhysicalId)).toEqual({
            ok: true,
            ids: [PROOF_PHYSICAL_ID],
        });
        expect(parseVectorProofPhysicalIds(1, parseCdbVectorizePhysicalId)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_IDS_TYPE_INVALID" },
        });
        expect(parseVectorProofPhysicalIds("[", parseCdbVectorizePhysicalId)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_IDS_JSON_INVALID" },
        });
        expect(parseVectorProofPhysicalIds("[]", parseCdbVectorizePhysicalId)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID" },
        });
        expect(
            parseVectorProofPhysicalIds(
                JSON.stringify([PROOF_PHYSICAL_ID, PROOF_PHYSICAL_ID]),
                parseCdbVectorizePhysicalId
            )
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID" },
        });
        expect(
            parseVectorProofPhysicalIds(JSON.stringify(["p1_not-a-production-identity"]), parseCdbVectorizePhysicalId)
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID" },
        });
    });

    test("persists exact fault ownership across reads and transfers it only on re-arm", () => {
        const otherVectorId = `vec1_${"cd".repeat(32)}`;
        const otherPhysicalId = cdbVectorizePhysicalId(otherVectorId, 1);
        const stored = JSON.stringify([PROOF_PHYSICAL_ID]);
        expect(
            scopeVectorProofFaultPhysicalIds(stored, PROOF_VECTOR_ID, PROOF_VECTOR_ID, parseCdbVectorizePhysicalId)
        ).toEqual({
            ok: true,
            ids: [PROOF_PHYSICAL_ID],
            appliesToExpectedVector: true,
        });
        expect(
            scopeVectorProofFaultPhysicalIds(stored, PROOF_VECTOR_ID, otherVectorId, parseCdbVectorizePhysicalId)
        ).toEqual({
            ok: true,
            ids: [PROOF_PHYSICAL_ID],
            appliesToExpectedVector: false,
        });
        expect(
            scopeVectorProofFaultPhysicalIds(null, otherVectorId, otherVectorId, parseCdbVectorizePhysicalId)
        ).toEqual({ ok: true, ids: [], appliesToExpectedVector: true });
        expect(
            scopeVectorProofFaultPhysicalIds(null, otherVectorId, PROOF_VECTOR_ID, parseCdbVectorizePhysicalId)
        ).toEqual({ ok: true, ids: [], appliesToExpectedVector: false });
        expect(resolveVectorProofFaultPhysicalIds(stored, null, parseCdbVectorizePhysicalId)).toEqual({
            ok: true,
            ids: [PROOF_PHYSICAL_ID],
            vectorId: PROOF_VECTOR_ID,
        });
        expect(resolveVectorProofFaultPhysicalIds(null, null, parseCdbVectorizePhysicalId)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID" },
        });
        expect(
            scopeVectorProofFaultPhysicalIds(
                JSON.stringify([PROOF_PHYSICAL_ID, otherPhysicalId]),
                PROOF_VECTOR_ID,
                PROOF_VECTOR_ID,
                parseCdbVectorizePhysicalId
            )
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID" },
        });
    });

    test("does not re-arm over held or incomplete evidence", () => {
        const mode = "upsert_accept_then_throw" as const;
        const pristine = {
            vectorId: PROOF_VECTOR_ID,
            mode,
            armed: true,
            inFlight: false,
            fired: false,
            firstPhysicalIds: null,
            firstPayloadSha256: null,
            returnedMutationIdSha256: null,
            acceptedBeforeThrow: false,
            retryCount: 0,
            retryIdsMatched: null,
            retryPayloadMatched: null,
            retryComplete: false,
            gateOpen: false,
            gateDeadline: null,
        } as const;
        expect(vectorProofFaultArmDecision(null, PROOF_VECTOR_ID, mode)).toBe("insert");
        expect(vectorProofFaultArmDecision(pristine, PROOF_VECTOR_ID, mode)).toBe("idempotent");

        const held = { ...pristine, inFlight: true, firstPhysicalIds: [PROOF_PHYSICAL_ID], gateDeadline: 10_000 };
        expect(() => vectorProofFaultArmDecision(held, PROOF_VECTOR_ID, mode)).toThrow(
            "cannot be re-armed before its evidence is complete"
        );
        const incomplete = {
            ...pristine,
            armed: false,
            fired: true,
            firstPhysicalIds: [PROOF_PHYSICAL_ID],
            firstPayloadSha256: "a".repeat(64),
            returnedMutationIdSha256: "b".repeat(64),
            acceptedBeforeThrow: true,
        };
        expect(() => vectorProofFaultArmDecision(incomplete, PROOF_VECTOR_ID, mode)).toThrow(
            "cannot be re-armed before its evidence is complete"
        );

        const complete = {
            ...incomplete,
            retryCount: 1,
            retryIdsMatched: true,
            retryPayloadMatched: true,
            retryComplete: true,
        };
        expect(vectorProofFaultArmDecision(complete, `vec1_${"cd".repeat(32)}`, mode)).toBe("replace");
        expect(() =>
            vectorProofFaultArmDecision({ ...complete, retryIdsMatched: false }, PROOF_VECTOR_ID, mode)
        ).toThrow("cannot be re-armed before its evidence is complete");
    });

    test("classifies acceptance identity failures without exposing stored values", () => {
        expect(
            validateVectorProofAcceptanceIdentity(
                PROOF_PHYSICAL_ID,
                PROOF_VECTOR_ID,
                PROOF_VECTOR_ID,
                parseCdbVectorizePhysicalId
            )
        ).toEqual({ ok: true });
        expect(
            validateVectorProofAcceptanceIdentity(1, PROOF_VECTOR_ID, PROOF_VECTOR_ID, parseCdbVectorizePhysicalId)
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_TYPE_INVALID" },
        });
        expect(
            validateVectorProofAcceptanceIdentity(
                "p1_not-a-production-identity",
                PROOF_VECTOR_ID,
                PROOF_VECTOR_ID,
                parseCdbVectorizePhysicalId
            )
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID" },
        });
        expect(
            validateVectorProofAcceptanceIdentity(
                PROOF_PHYSICAL_ID,
                `vec1_${"cd".repeat(32)}`,
                PROOF_VECTOR_ID,
                parseCdbVectorizePhysicalId
            )
        ).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_VECTOR_ID_MISMATCH" },
        });
    });

    test("normalizes safe SQLite terminal flags without assuming one integer representation", () => {
        expect(normalizeVectorProofTerminalFlag(0)).toBe(0);
        expect(normalizeVectorProofTerminalFlag(1)).toBe(1);
        expect(normalizeVectorProofTerminalFlag(0n)).toBe(0);
        expect(normalizeVectorProofTerminalFlag(1n)).toBe(1);
        expect(() => normalizeVectorProofTerminalFlag(null)).toThrow("proof vector terminal failure flag is invalid");
        expect(() => normalizeVectorProofTerminalFlag(false)).toThrow("proof vector terminal failure flag is invalid");
        expect(() => normalizeVectorProofTerminalFlag("0")).toThrow("proof vector terminal failure flag is invalid");
        expect(() => normalizeVectorProofTerminalFlag(2)).toThrow("proof vector terminal failure flag is invalid");
        expect(() => normalizeVectorProofTerminalFlag(Number.MAX_SAFE_INTEGER + 1)).toThrow(
            "proof vector terminal failure flag is invalid"
        );
        expect(() => normalizeVectorProofTerminalFlag(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
            "proof vector terminal failure flag is invalid"
        );
        expect(normalizeVectorProofSqlInteger(1n, 0, 1)).toEqual({ ok: true, value: 1 });
        expect(parseVectorProofTerminalFlag(null)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(undefined)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID" },
        });
        expect(parseVectorProofTerminalFlag("0")).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TEXT_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(false)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TYPE_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(new ArrayBuffer(1))).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_BLOB_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(0.5)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID" },
        });
        expect(parseVectorProofTerminalFlag(2)).toEqual({
            ok: false,
            error: { code: "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_RANGE_INVALID" },
        });
        expect(requireVectorProofSqlInteger(42n)).toBe(42);
        expect(requireNullableVectorProofSqlInteger(null)).toBeNull();
        expect(requireNullableVectorProofSqlInteger(7n)).toBe(7);
        expect(requireVectorProofSqlFlag(1n)).toBeTrue();
        expect(requireVectorProofSqlFlag(0)).toBeFalse();
        expect(requireNullableVectorProofSqlFlag(null)).toBeNull();
        expect(() => requireVectorProofSqlInteger("7")).toThrow("proof SQL integer is invalid");
        expect(() => requireVectorProofSqlFlag(2)).toThrow("proof SQL integer is invalid");
        expect(() => requireNullableVectorProofSqlInteger(undefined)).toThrow("proof SQL integer is invalid");
    });

    test("builds the private bridge into dist without adding a package export", async () => {
        const [buildConfig, packageText, serverIndex] = await Promise.all([
            readFile(path.join(ROOT, "build.config.ts"), "utf8"),
            readFile(path.join(ROOT, "package.json"), "utf8"),
            readFile(path.join(ROOT, "src", "server", "index.ts"), "utf8"),
        ]);
        const packageJson = JSON.parse(packageText) as { readonly files?: string[]; readonly exports?: object };
        expect(buildConfig).toContain('"src/internal/vector-proof"');
        expect(packageJson.files).toContain("dist");
        expect(packageJson.exports).not.toHaveProperty("./internal/vector-proof");
        expect(serverIndex).not.toContain("vector-proof");
    });
});
