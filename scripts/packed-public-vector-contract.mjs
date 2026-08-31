import { isDeepStrictEqual } from "node:util";

export const PACKED_PUBLIC_VECTOR_SCHEMA = "chardb.packed-public-vector-browser.v1";

export const PACKED_LOCAL_VECTOR_CAPABILITY = Object.freeze({
    proof: "local-semantic",
    runtime: "browser",
    provider: "scripted-websocket",
    realVectorize: false,
    providerCalls: false,
    doctorConfigs: Object.freeze(["wrangler.toml", "wrangler.json", "wrangler.jsonc"]),
    remoteBindingContract: "required",
    prepareFailureDiagnostics: "bounded-redacted-actionable-tail",
});

export const PUBLIC_VECTOR_QUERY_REF = "src/queries.ts#searchMessages";

const INTERNAL_SENTINELS = [
    "bindCdbVectorMutationContext",
    "cdbVectorLogicalId",
    "isChardbVectorSearchBuilder",
    "normalizeChardbVectorSearchBuilder",
    "resolveOrganizationVectorResourceDescriptor",
    "_chardb_vectors",
    "PUBLIC_VECTOR_SERVER_CALLBACK_SENTINEL",
    "CDB_MESSAGES_VECTOR_INDEX",
];

export function assertPackedPublicVectorBundle(code) {
    assert(typeof code === "string" && code.length > 0, "packed public vector browser bundle is empty");
    assert(code.includes(PUBLIC_VECTOR_QUERY_REF), "browser bundle lost the public vector query ref");
    for (const sentinel of INTERNAL_SENTINELS) {
        assert(!code.includes(sentinel), `browser bundle leaked server-only vector symbol ${JSON.stringify(sentinel)}`);
    }
    assert(!code.includes("cloudflare:workers"), "browser bundle contains a Cloudflare Worker import");
    assert(!code.includes("better-auth/plugins/organization"), "browser bundle contains Better Auth server code");
}

export function assertPackedPublicVectorBrowserProof(proof) {
    assert(proof?.schema === PACKED_PUBLIC_VECTOR_SCHEMA, "browser returned the wrong proof schema");
    assert(proof?.queryRef === PUBLIC_VECTOR_QUERY_REF, "useQuery subscribed with the wrong public query ref");
    assert(
        JSON.stringify(proof?.queryArgs) ===
            JSON.stringify({ organizationId: "org-browser-proof", values: [1, 0, 0], limit: 5 }),
        "useQuery changed the public vector query arguments"
    );

    const observations = Array.isArray(proof?.observations) ? proof.observations : [];
    const rows = observations.flatMap(observation => (Array.isArray(observation?.rows) ? observation.rows : []));
    for (const row of rows) {
        assert(row !== null && typeof row === "object" && !Array.isArray(row), "vector result row is not an object");
        assert(
            JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["rowPk", "score"]),
            `vector result leaked non-public fields: ${JSON.stringify(Object.keys(row).sort())}`
        );
    }
    assert(
        containsOrderedObservations(observations, [
            { state: "pending", rows: [] },
            { state: "live", rows: [{ rowPk: "message-a", score: 0.98 }] },
            { state: "refetching", rows: [] },
            { state: "live", rows: [{ rowPk: "message-b", score: 0.91 }] },
        ]),
        `useQuery did not expose pending, live, refetching, live in order: ${JSON.stringify(observations)}`
    );

    const sent = Array.isArray(proof?.sent) ? proof.sent : [];
    const subscriptions = sent.filter(message => message?.t === "sub");
    assert(subscriptions.length === 2, `expected initial and refetch subscriptions, got ${subscriptions.length}`);
    for (const subscription of subscriptions) {
        assert(subscription.ref === PUBLIC_VECTOR_QUERY_REF, "wire subscription used the wrong public query ref");
        assert(
            JSON.stringify(subscription.args) === JSON.stringify(proof.queryArgs),
            "wire subscription changed query args"
        );
        assert(
            JSON.stringify(Object.keys(subscription).sort()) === JSON.stringify(["args", "ref", "subId", "t"]),
            `wire subscription leaked fields: ${JSON.stringify(Object.keys(subscription).sort())}`
        );
    }
    const acknowledgements = sent.filter(message => message?.t === "ack").map(message => message.cookie);
    assert(
        JSON.stringify(acknowledgements) === JSON.stringify(["browser-proof:1", "browser-proof:2"]),
        `client did not acknowledge both authoritative snapshots: ${JSON.stringify(acknowledgements)}`
    );
}

export function assertPackedLocalVectorCapability(value) {
    assert(value !== null && typeof value === "object" && !Array.isArray(value), "packed local capability is missing");
    assert(
        isDeepStrictEqual(Object.keys(value).sort(), Object.keys(PACKED_LOCAL_VECTOR_CAPABILITY).sort()) &&
            isDeepStrictEqual(value, PACKED_LOCAL_VECTOR_CAPABILITY),
        "packed browser evidence must identify a local semantic fake with no Vectorize provider calls"
    );
    return value;
}

export function assertMatchingPackedPublicVectorReport(report, fingerprint, reactFingerprint) {
    assert(
        report !== null && typeof report === "object" && !Array.isArray(report),
        "packed public vector evidence must be an object"
    );
    assert(
        report.schema === PACKED_PUBLIC_VECTOR_SCHEMA,
        `packed public vector evidence schema must be ${PACKED_PUBLIC_VECTOR_SCHEMA}`
    );
    assert(report.ok === true, "packed public vector evidence did not pass");
    assertPackedLocalVectorCapability(report.capability);
    assert(
        isDeepStrictEqual(report.package?.tarball, fingerprint),
        "packed public vector evidence does not identify the preview tarball"
    );
    assert(
        report.reactPackage?.name === "@chardb/react" &&
            (reactFingerprint === undefined || isDeepStrictEqual(report.reactPackage?.tarball, reactFingerprint)),
        "packed public vector evidence does not identify the preview React tarball"
    );
    assertPackedPublicVectorBrowserProof(report.proof);
    return report;
}

function containsOrderedObservations(actual, expected) {
    let cursor = 0;
    for (const observation of actual) {
        if (JSON.stringify(observation) === JSON.stringify(expected[cursor])) cursor++;
        if (cursor === expected.length) return true;
    }
    return false;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
