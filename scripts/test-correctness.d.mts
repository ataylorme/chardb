export interface CorrectnessRunOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly stdin?: "inherit" | "ignore";
    readonly stdout?: "inherit" | "ignore" | Bun.BunFile;
    readonly stderr?: "inherit" | "ignore" | Bun.BunFile;
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
}

export function run(
    label: string,
    args: readonly string[],
    timeoutMs?: number,
    options?: CorrectnessRunOptions
): Promise<void>;

export function main(argv?: readonly string[]): Promise<void>;
