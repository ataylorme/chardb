import { describe, expect, test } from "bun:test";
import { injectGeneratedDevInspectorPort, injectGeneratedLoopbackProbe } from "../scripts/generated-loopback-probe.mjs";

describe("generated Worker loopback probe", () => {
    test("inserts before the default export without depending on health-route formatting", () => {
        const source = `export const app = chardb({ ownership: "user" });
app.get(
  "/health",
  (c) => c.json({ ok: true, schemaVersion: migrations.version, schemaDigest: migrations.digest }),
);

export default app;
export const { DB } = app;
`;
        const instrumented = injectGeneratedLoopbackProbe(source);
        expect(instrumented).toContain('app.get("/__chardb_loopback_probe"');
        expect(instrumented.indexOf('app.get("/__chardb_loopback_probe"')).toBeLessThan(
            instrumented.indexOf("export default app;")
        );
        expect(instrumented).toContain("schemaDigest: migrations.digest");
        expect(instrumented).toEndWith("export const { DB } = app;\n");
    });

    test("fails closed when the generated app structure is missing, ambiguous, or already instrumented", () => {
        expect(() => injectGeneratedLoopbackProbe("export default app;\n")).toThrow("health route is missing");
        expect(() =>
            injectGeneratedLoopbackProbe('app.get("/health", handler);\nexport const app = worker;\n')
        ).toThrow("exactly one default app export");
        expect(() =>
            injectGeneratedLoopbackProbe('app.get("/health", handler);\nexport default app;\nexport default app;\n')
        ).toThrow("exactly one default app export");
        expect(() =>
            injectGeneratedLoopbackProbe(
                'app.get("/health", handler);\napp.get("/__chardb_loopback_probe", handler);\nexport default app;\n'
            )
        ).toThrow("already contains the loopback probe");
    });
});

describe("generated dev inspector isolation", () => {
    const source = `const worker = Bun.spawn(
  [
    nodeRuntime,
    wranglerModule,
    "dev",
    "--ip",
    origin.hostname,
    "--port",
    origin.port || "8787",
    "--persist-to",
    persistTo,
  ],
);
`;

    test("adds one explicit inspector port without changing the generated template", () => {
        const instrumented = injectGeneratedDevInspectorPort(source, 49_152);
        expect(instrumented).toContain(`    "--port",
    origin.port || "8787",
    "--inspector-port",
    "49152",
    "--persist-to",`);
        expect(source).not.toContain("--inspector-port");
    });

    test("fails closed for invalid ports and template drift", () => {
        for (const port of [0, 65_536, 1.5, Number.NaN]) {
            expect(() => injectGeneratedDevInspectorPort(source, port)).toThrow("integer from 1 through 65535");
        }
        expect(() => injectGeneratedDevInspectorPort("", 49_152)).toThrow("exactly one");
        expect(() => injectGeneratedDevInspectorPort(`${source}\n${source}`, 49_152)).toThrow("exactly one");
        expect(() => injectGeneratedDevInspectorPort(`${source}\n"--inspector-port"`, 49_152)).toThrow("already sets");
    });
});
