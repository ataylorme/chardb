import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprintFile } from "./browser-benchmark-report.mjs";

const SCHEMA_MARKER = '        createdAt: integer("created_at").notNull(),';
const MIGRATIONS_V1 = "export const migrations = defineMigrations([initialSchema]);";
const MIGRATIONS_V2 = `export const migrations = defineMigrations([
    initialSchema,
    {
        version: 2,
        name: "add_message_edited_at",
        statements: ['ALTER TABLE "messages" ADD COLUMN "edited_at" integer'],
    },
]);`;

export function parsePreviewUpgradeArgs(argv) {
    let input;
    let output;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument !== "--input" && argument !== "--output") {
            throw new Error(`Unknown preview upgrade argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (!value) throw new Error(`${argument} requires a value`);
        if (argument === "--input") input = value;
        else output = value;
    }
    if (!help && input === undefined) throw new Error("--input is required");
    if (!help && output === undefined) throw new Error("--output is required");
    return { help, input, output };
}

export function renderVersionTwoSchema(source) {
    if (!source.includes(SCHEMA_MARKER)) throw new Error("preview version-one schema marker is missing");
    if (source.includes('editedAt: integer("edited_at")')) {
        throw new Error("preview input already contains the version-two column");
    }
    return source.replace(SCHEMA_MARKER, `${SCHEMA_MARKER}\n        editedAt: integer("edited_at"),`);
}

export function renderVersionTwoMigrations(source) {
    if (!source.includes(MIGRATIONS_V1)) throw new Error("preview version-one migration journal marker is missing");
    return source.replace(MIGRATIONS_V1, MIGRATIONS_V2);
}

function usage() {
    return [
        "Usage: bun scripts/prepare-preview-upgrade.mjs --input <v1-app> --output <v2-app>",
        "",
        "Copies one prepared preview app and appends the fixed version-two migration.",
    ].join("\n");
}

async function main() {
    const options = parsePreviewUpgradeArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    const input = path.resolve(options.input);
    const output = path.resolve(options.output);
    await mkdir(output, { recursive: true });
    if ((await readdir(output)).length > 0) throw new Error(`preview upgrade output is not empty: ${output}`);

    await cp(input, output, {
        recursive: true,
        filter: source => {
            const relative = path.relative(input, source);
            if (relative === "") return true;
            const first = relative.split(path.sep, 1)[0];
            return !["node_modules", "dist", "worker-dist", ".wrangler"].includes(first);
        },
    });

    const schemaPath = path.join(output, "src", "server", "schema.ts");
    const migrationsPath = path.join(output, "src", "server", "migrations.ts");
    const frozenV1Path = path.join(output, "src", "server", "migrations", "v1.ts");
    const frozenV1Before = await fingerprintFile(frozenV1Path);
    await writeFile(schemaPath, renderVersionTwoSchema(await readFile(schemaPath, "utf8")));
    await writeFile(migrationsPath, renderVersionTwoMigrations(await readFile(migrationsPath, "utf8")));
    const frozenV1After = await fingerprintFile(frozenV1Path);
    if (JSON.stringify(frozenV1Before) !== JSON.stringify(frozenV1After)) {
        throw new Error("preview version-one migration snapshot changed during upgrade preparation");
    }

    const previewManifestPath = path.join(output, "preview-manifest.json");
    const previewManifest = JSON.parse(await readFile(previewManifestPath, "utf8"));
    await writeFile(
        previewManifestPath,
        `${JSON.stringify(
            {
                ...previewManifest,
                schema: "chardb.preview-deployment.v2",
                upgrade: {
                    fromVersion: 1,
                    toVersion: 2,
                    frozenV1: frozenV1After,
                    schema: await fingerprintFile(schemaPath),
                    migrations: await fingerprintFile(migrationsPath),
                },
            },
            null,
            2
        )}\n`
    );
    console.log(`prepared version-two preview app in ${output}`);
}

if (import.meta.main) await main();
