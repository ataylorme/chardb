import { join } from "node:path";
import type { CliCommandResult, CliContext } from "../context.ts";
import { configuredVectorizeIndexNames } from "../wrangler_template.ts";

const PROPERTY = "cdb_resource";
const TYPE = "string";
const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_WRANGLER_FAILURE_TAIL_BYTES = 4 * 1_024;

type MetadataIndexState = "missing" | "ready";

export interface VectorizePrepareOptions {
    readonly pollAttempts?: number;
    readonly pollIntervalMs?: number;
    readonly commandTimeoutMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
}

function unwrapWranglerJson(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const envelope = value as { readonly success?: unknown; readonly errors?: unknown; readonly result?: unknown };
    if (envelope.success !== undefined && envelope.success !== true) {
        throw new Error("Wrangler metadata-index response reports failure");
    }
    if (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) {
        throw new Error("Wrangler metadata-index response contains errors");
    }
    return envelope.result === undefined ? value : envelope.result;
}

function normalizedType(value: unknown): "string" | "number" | "boolean" | undefined {
    if (value === "String") return "string";
    if (value === "Number") return "number";
    if (value === "Boolean") return "boolean";
    if (value === "string" || value === "number" || value === "boolean") return value;
    return undefined;
}

/** Strictly classify one Wrangler `list-metadata-index --json` response. */
export function classifyVectorizeMetadataIndexes(input: unknown): MetadataIndexState {
    const unwrapped = unwrapWranglerJson(input);
    const indexes = Array.isArray(unwrapped)
        ? unwrapped
        : typeof unwrapped === "object" &&
            unwrapped !== null &&
            Array.isArray((unwrapped as { readonly metadataIndexes?: unknown }).metadataIndexes)
          ? (unwrapped as { readonly metadataIndexes: readonly unknown[] }).metadataIndexes
          : undefined;
    if (!indexes) throw new Error("Wrangler metadata-index response must contain an index array");

    let targetType: "string" | "number" | "boolean" | undefined;
    for (const entry of indexes) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new Error("Wrangler returned a malformed metadata index");
        }
        const index = entry as {
            readonly propertyName?: unknown;
            readonly property_name?: unknown;
            readonly type?: unknown;
            readonly indexType?: unknown;
            readonly index_type?: unknown;
        };
        if (
            index.propertyName !== undefined &&
            index.property_name !== undefined &&
            index.propertyName !== index.property_name
        ) {
            throw new Error("Wrangler returned conflicting metadata-index property names");
        }
        const propertyName = index.propertyName ?? index.property_name;
        if (typeof propertyName !== "string" || propertyName.length === 0) {
            throw new Error("Wrangler returned a malformed metadata-index property name");
        }
        const rawTypes = [index.type, index.indexType, index.index_type].filter(value => value !== undefined);
        const types = rawTypes.map(normalizedType);
        if (types.length === 0 || types.some(type => type === undefined) || new Set(types).size !== 1) {
            throw new Error("Wrangler returned a malformed or conflicting metadata-index type");
        }
        if (propertyName !== PROPERTY) continue;
        if (targetType !== undefined)
            throw new Error(`Vectorize metadata index ${JSON.stringify(PROPERTY)} is duplicated`);
        targetType = types[0];
    }
    if (targetType === undefined) return "missing";
    if (targetType !== TYPE) {
        throw new Error(
            `Vectorize metadata index ${JSON.stringify(PROPERTY)} has type ${JSON.stringify(targetType)}; expected ${JSON.stringify(TYPE)}`
        );
    }
    return "ready";
}

function redactWranglerOutput(value: string): string {
    return value
        .replace(/((?:"?authorization"?)\s*[:=]\s*"?(?:bearer\s+)?)[^"\s,;]+/gi, "$1<redacted>")
        .replace(
            /((?:"?(?:x-auth-key|x-auth-email|cloudflare[_-]?api[_-]?key|api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|client[_-]?secret|secret)"?)\s*[:=]\s*"?)[^"\s,;]+/gi,
            "$1<redacted>"
        )
        .replace(/([?&](?:token|key|secret|authorization)=)[^&\s]+/gi, "$1<redacted>")
        .replace(
            /(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>]*?(?:\.wrangler|credentials?|tokens?|auth)[^\s"'<>]*/gi,
            "<redacted-path>"
        )
        .replace(/\/[^\s"'<>]*(?:\.wrangler|credentials?|tokens?|auth)[^\s"'<>]*/gi, "<redacted-path>")
        .replace(/\b[a-f0-9]{32}\b/gi, "<redacted-account-id>")
        .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted-token>");
}

function utf8Tail(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength <= maxBytes) return value;
    return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes)).replace(/^\uFFFD/, "");
}

function wranglerFailure(result: CliCommandResult, subject: string, detail?: string): Error {
    assertCommandResult(result, subject);
    const streams = [
        result.stdout.trim().length > 0 ? `[stdout]\n${result.stdout.trimEnd()}` : "",
        result.stderr.trim().length > 0 ? `[stderr]\n${result.stderr.trimEnd()}` : "",
    ].filter(Boolean);
    const tail = utf8Tail(redactWranglerOutput(streams.join("\n")), MAX_WRANGLER_FAILURE_TAIL_BYTES);
    return new Error(
        `${subject} failed with exit code ${result.exitCode}${detail ? ` ${detail}` : ""}${tail ? `\nWrangler output tail:\n${tail}` : ""}`
    );
}

function parseJson(result: CliCommandResult, subject: string): unknown {
    assertCommandResult(result, subject);
    if (result.exitCode !== 0) {
        throw wranglerFailure(result, subject);
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`${subject} returned malformed JSON`);
    }
}

function assertCommandResult(result: CliCommandResult, subject: string): void {
    if (
        !Number.isSafeInteger(result.exitCode) ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string"
    ) {
        throw new Error(`${subject} returned an invalid process result`);
    }
}

async function configPath(ctx: CliContext): Promise<string> {
    for (const name of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
        const candidate = join(ctx.cwd, name);
        if (await ctx.exists(candidate)) return candidate;
    }
    throw new Error("Wrangler config not found; expected wrangler.toml, wrangler.json, or wrangler.jsonc");
}

export async function runVectorizePrepare(ctx: CliContext, options: VectorizePrepareOptions = {}): Promise<void> {
    const attempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const commandTimeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
        throw new TypeError("Vectorize metadata-index poll attempts must be an integer from 1 through 120");
    }
    if (!Number.isSafeInteger(interval) || interval < 0 || interval > 60_000) {
        throw new TypeError(
            "Vectorize metadata-index poll interval must be an integer from 0 through 60000 milliseconds"
        );
    }
    if (!Number.isSafeInteger(commandTimeout) || commandTimeout < 1 || commandTimeout > 120_000) {
        throw new TypeError("Vectorize Wrangler command timeout must be an integer from 1 through 120000 milliseconds");
    }
    if (!ctx.runCommand) throw new Error("external command execution is unavailable");
    const config = await configPath(ctx);
    const indexes = configuredVectorizeIndexNames(await ctx.read(config));
    if (indexes.length === 0) {
        ctx.stdout(
            `chardb vectorize prepare: no Vectorize indexes configured in ${config.slice(ctx.cwd.length + 1)}\n`
        );
        return;
    }
    ctx.stdout("chardb vectorize prepare: remote Cloudflare provider operation; no local Miniflare index is created\n");
    const wranglerModule = join(ctx.cwd, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!(await ctx.exists(wranglerModule))) {
        throw new Error("project Wrangler CLI entrypoint not found; install project dependencies first");
    }
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("Wrangler requires Node.js on PATH");
    const invoke = async (args: readonly string[]): Promise<CliCommandResult> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const operation = ctx.runCommand?.({
                executable: nodeRuntime,
                args: [wranglerModule, ...args],
                cwd: ctx.cwd,
                timeoutMs: commandTimeout,
                maxOutputBytes: 64 * 1_024,
            });
            if (!operation) throw new Error("external command execution is unavailable");
            return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`project Wrangler command exceeded its ${commandTimeout}ms timeout`)),
                        commandTimeout
                    );
                }),
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    };
    const list = async (indexName: string): Promise<MetadataIndexState> => {
        const result = await invoke(["vectorize", "list-metadata-index", indexName, "--json", "--config", config]);
        return classifyVectorizeMetadataIndexes(
            parseJson(result, `Vectorize index ${JSON.stringify(indexName)} inspection`)
        );
    };

    // Refuse known conflicts before creating any missing index.
    const states = new Map<string, MetadataIndexState>();
    for (const indexName of indexes) states.set(indexName, await list(indexName));
    for (const indexName of indexes) {
        if (states.get(indexName) === "ready") {
            ctx.stdout(`chardb vectorize prepare: ${JSON.stringify(indexName)} already has ${PROPERTY}:${TYPE}\n`);
            continue;
        }
        const created = await invoke([
            "vectorize",
            "create-metadata-index",
            indexName,
            "--propertyName",
            PROPERTY,
            "--type",
            TYPE,
            "--config",
            config,
        ]);
        const creationSubject = `Vectorize index ${JSON.stringify(indexName)} metadata-index creation`;
        assertCommandResult(created, creationSubject);
        let ready = false;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if ((await list(indexName)) === "ready") {
                ready = true;
                break;
            }
            if (attempt + 1 < attempts) {
                await (options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(
                    interval
                );
            }
        }
        if (!ready) {
            if (created.exitCode !== 0) {
                throw wranglerFailure(
                    created,
                    creationSubject,
                    `and ${PROPERTY}:${TYPE} did not become ready after ${attempts} checks`
                );
            }
            throw new Error(
                `Vectorize index ${JSON.stringify(indexName)} did not expose ${PROPERTY}:${TYPE} after ${attempts} readiness checks`
            );
        }
        ctx.stdout(
            `chardb vectorize prepare: ${JSON.stringify(indexName)} ${created.exitCode === 0 ? "created" : "confirmed"} ${PROPERTY}:${TYPE}\n`
        );
    }
}
