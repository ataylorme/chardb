export interface MiniflareLifecycleInstance {
    readonly ready: Promise<URL>;
    dispose(): Promise<void>;
}

export type MiniflareDisposal =
    | { readonly status: "absent" }
    | { readonly status: "disposed" }
    | { readonly status: "timed-out" }
    | { readonly status: "rejected"; readonly error: unknown };

export interface MiniflareDisposalOptions {
    readonly timeoutMs?: number;
    readonly label?: string;
    readonly diagnose?: (message: string, error?: unknown) => void;
    readonly onTimeout?: () => void;
}

export declare function disposeMiniflareBounded(
    instance: Pick<MiniflareLifecycleInstance, "dispose"> | undefined,
    options?: MiniflareDisposalOptions
): Promise<MiniflareDisposal>;

export declare function restartMiniflareBounded<T extends MiniflareLifecycleInstance>(
    current: Pick<MiniflareLifecycleInstance, "dispose"> | undefined,
    start: () => T,
    options?: {
        readonly disposeTimeoutMs?: number;
        readonly readyTimeoutMs?: number;
        readonly settleDelayMs?: number;
        readonly label?: string;
        readonly diagnose?: (message: string, error?: unknown) => void;
        readonly onDisposeTimeout?: () => void;
    }
): Promise<{ readonly instance: T; readonly origin: URL; readonly disposal: MiniflareDisposal }>;
