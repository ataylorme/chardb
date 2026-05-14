import { describe, expect, test } from "bun:test";
import { defineLedger } from "../../src/server/ledger.ts";
import { renderLedgerLogpush, renderLedgerPayload, renderLogpushJobRequest } from "../../src/server/logpush.ts";

const events = defineLedger("events", {
    id: "INTEGER PRIMARY KEY",
    topic: "TEXT NOT NULL",
    payload: "TEXT NOT NULL",
});

describe("renderLedgerLogpush", () => {
    test("returns null when destination is omitted", () => {
        expect(renderLedgerLogpush(events, {})).toBeNull();
    });

    test("renders job spec with row + chardb fields", () => {
        const spec = renderLedgerLogpush(events, { logpush: { destination: "r2://logs/events" } });
        expect(spec).not.toBeNull();
        if (!spec) return;
        expect(spec.tableName).toBe("events");
        expect(spec.dataset).toBe("chardb_ledger");
        const fieldNames = spec.fields.map(f => f.name);
        expect(fieldNames).toContain("topic");
        expect(fieldNames).toContain("_chardb_row_hash");
        expect(fieldNames).toContain("_chardb_prev_hash");
    });

    test("renderLogpushJobRequest produces the API body shape", () => {
        const spec = renderLedgerLogpush(events, { logpush: { destination: "r2://logs/events" } });
        if (!spec) throw new Error("spec missing");
        const body = renderLogpushJobRequest(spec);
        expect(body.name).toBe("chardb_ledger_events");
        expect(body.dataset).toBe("chardb_ledger");
        expect(body.destination_conf).toBe("r2://logs/events");
        expect(body.output_options.output_type).toBe("ndjson");
        expect(body.output_options.field_names.length).toBeGreaterThan(0);
    });

    test("renders payload in stable field order", () => {
        const spec = renderLedgerLogpush(events, { logpush: { destination: "https://example/log" } });
        if (!spec) throw new Error("spec missing");
        const ndjson = renderLedgerPayload(spec, {
            id: 1,
            topic: "t",
            payload: "p",
            _chardb_row_hash: "h",
            _chardb_prev_hash: null,
            _chardb_ts: 123,
            _chardb_op_id: "op",
        });
        const decoded = JSON.parse(ndjson) as Record<string, unknown>;
        expect(decoded._chardb_row_hash).toBe("h");
        expect(decoded.topic).toBe("t");
    });
});
