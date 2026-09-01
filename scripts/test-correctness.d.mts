export interface CorrectnessRunOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly stdin?: "inherit" | "ignore";
    readonly stdout?: "inherit" | "ignore" | Bun.BunFile;
    readonly stderr?: "inherit" | "ignore" | Bun.BunFile;
    readonly captureOutput?: boolean;
    readonly terminationGraceMs?: number;
    readonly signalSource?: {
        on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
        off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    };
}

export class ChildProcessFailure extends Error {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly stdoutTail: string;
    readonly stderrTail: string;
}

export function isTransientWorkerdStartupFailure(error: unknown): boolean;

export function compareWorkerdHarnesses(left: string, right: string): number;

export function isIsolatedNativeTest(file: string): boolean;

export function run(
    label: string,
    args: readonly string[],
    timeoutMs?: number,
    options?: CorrectnessRunOptions
): Promise<void>;

export function runWithRetries(
    label: string,
    args: readonly string[],
    timeoutMs?: number,
    options?: CorrectnessRunOptions & {
        readonly attempts?: number;
        readonly retryDelayMs?: number;
        readonly shouldRetry?: (error: ChildProcessFailure) => boolean;
    }
): Promise<void>;

export function main(argv?: readonly string[]): Promise<void>;
