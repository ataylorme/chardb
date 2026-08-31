import type { EventEmitter } from "node:events";

export class ManagedProcessError extends Error {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

export function settleBounded<T>(
    operation: () => T | PromiseLike<T>,
    options?: { label?: string; timeoutMs?: number }
): Promise<T>;

export function preserveFailure(primary: unknown | undefined, cleanup: unknown | undefined, label?: string): unknown;

export interface ManagedChild {
    readonly pid: number;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stdout: ReadableStream<Uint8Array> | number | undefined;
    readonly stderr: ReadableStream<Uint8Array> | number | undefined;
    kill(signal?: NodeJS.Signals): void;
}

export interface ManagedProcess {
    readonly child: ManagedChild;
    readonly interruptedSignal: NodeJS.Signals | null;
    stop(signal?: NodeJS.Signals): Promise<number | null>;
}

export function spawnManagedProcess(
    command: readonly string[],
    options?: Record<string, unknown> & {
        label?: string;
        graceMs?: number;
        forceMs?: number;
        signalSource?: EventEmitter;
    }
): ManagedProcess;

export function runManagedCommand(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown> & {
        captureOutput?: boolean;
        mirrorOutput?: boolean;
        outputLimit?: number;
        reject?: boolean;
        timeoutMs?: number;
        label?: string;
    }
): Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}>;

export function isolateProcessTree(
    scriptUrl: string | URL,
    options?: { argv?: readonly string[]; label?: string; timeoutMs?: number }
): Promise<boolean>;
