export interface CloudflareVectorizeProofLiveEvidence {
    readonly sdk: "installed-candidate-createChardbClient";
    readonly transport: "worker-websocket";
    readonly auth: "better-auth-jwt";
    readonly queryRefSha256: string;
    readonly clientIdSha256: string;
    readonly connectionCount: 2;
    readonly helloCount: 2;
    readonly welcomeCount: 2;
    readonly reconnectCount: 1;
    readonly authReadCount: number;
    readonly snapshotCount: number;
    readonly acknowledgementCount: number;
    readonly acknowledgementEverySnapshot: true;
    readonly resume: {
        readonly attempted: true;
        readonly helloResumeMatchedInitialAck: true;
        readonly welcomeResumeMatchedInitialAck: true;
        readonly recovery: "lagged-refetch";
        readonly refetchReason: "lagged";
        readonly refetchStateCount: 1;
        readonly baselineRestoreCount: 1;
        readonly baselineRestoredExactly: true;
        readonly baselineRestoreAcknowledged: true;
        readonly initialCookieSha256: string;
        readonly finalCookieSha256: string;
    };
    readonly content: {
        readonly callbackCount: 4;
        readonly baselineUpdateCount: 1;
        readonly pendingFallbackUpdateCount: 1;
        readonly prematureCurrentUpdateCount: 0;
        readonly replacementUpdateCount: 1;
        readonly duplicateContentUpdateCount: 0;
        readonly baselineRowsSha256: string;
        readonly pendingFallbackRowPkSha256: string;
        readonly pendingRowsSha256: string;
        readonly replacementRowsSha256: string;
    };
}

export interface CloudflareVectorizeProofLiveSubscription {
    reconnect(): Promise<{ readonly recovery: "lagged-refetch" }>;
    beginReplacement(): void;
    waitForPending(): Promise<{ readonly elapsedMs: number }>;
    assertPending(): void;
    allowCurrent(): void;
    waitForCurrent(): Promise<{ readonly elapsedMs: number }>;
    finish(): CloudflareVectorizeProofLiveEvidence;
    abort(): void;
}

export function openCloudflareVectorizeProofLiveSubscription(
    input: {
        readonly candidateEntry: string | URL;
        readonly origin: string | URL;
        readonly organizationId: string;
        readonly expectedRowPk: string;
        readonly expectedPendingFallbackRowPk: string;
        readonly values: readonly number[];
        readonly clientId: string;
        readonly jwt: string;
        readonly getJwt?: () => Promise<string>;
        readonly timeoutMs: number;
        readonly reconnectStabilityMs?: number;
    },
    dependencies?: Readonly<Record<string, unknown>>
): Promise<CloudflareVectorizeProofLiveSubscription>;
