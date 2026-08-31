export interface LocalFileProofChild {
    readonly pid: number;
    readonly exitCode: number | null;
    readonly exited: Promise<number>;
    readonly stdout?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | null;
    readonly stderr?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | null;
    kill(signal?: NodeJS.Signals): unknown;
}

export interface LocalFileProofRuntimeInput {
    readonly app: string;
    readonly config?: string;
    readonly persistenceDir: string;
    readonly secretsFile: string;
    readonly wrangler: string;
    readonly runtimeExecutable?: string;
    readonly releaseSha256: string;
    readonly env?: Record<string, string | undefined>;
    readonly logLimitBytes?: number;
    readonly startupTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly graceMs?: number;
    readonly healthPath?: string;
    readonly healthHeaders?: HeadersInit;
    readonly healthReady?: (body: unknown, releaseSha256: string) => boolean;
}

export interface LocalFileProofRuntimeDependencies {
    readonly reservePort?: () => Promise<number>;
    readonly preparePersistence?: (directory: string) => Promise<unknown>;
    readonly readSecretsFile?: (file: string) => Promise<string>;
    readonly installDevVars?: (file: string, contents: string) => Promise<unknown>;
    readonly removeDevVars?: (file: string) => Promise<unknown>;
    readonly spawn?: (
        command: readonly string[],
        options: {
            readonly cwd: string;
            readonly env: Record<string, string | undefined>;
            readonly stdout: "pipe";
            readonly stderr: "pipe";
            readonly detached: boolean;
        }
    ) => LocalFileProofChild;
    readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    readonly signalGroup?: (child: LocalFileProofChild, signal: NodeJS.Signals) => boolean;
    readonly groupAlive?: (child: LocalFileProofChild) => boolean;
    readonly sleep?: (milliseconds: number) => Promise<unknown>;
    readonly now?: () => number;
}

export interface LocalFileProofRuntime {
    readonly origin: string;
    readonly port: number;
    readonly releaseSha256: string;
    readonly health: unknown;
    readonly command: readonly string[];
    readonly logs: {
        stdout(): string;
        stderr(): string;
    };
    stop(): Promise<void>;
}

export function reserveLoopbackPort(createServerImpl?: typeof import("node:net").createServer): Promise<number>;

export function startLocalFileProofRuntime(
    input: LocalFileProofRuntimeInput,
    dependencies?: LocalFileProofRuntimeDependencies
): Promise<LocalFileProofRuntime>;
