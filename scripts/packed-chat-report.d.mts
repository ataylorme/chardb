export declare const PACKED_CHAT_REPORT_SCHEMA: "chardb.packed-chat-proof.report.v1";
export declare const PACKED_CHAT_RESTART_HANDOFF_SCHEMA: "chardb.packed-chat-restart-handoff.v1";
export declare const PACKED_CHAT_RESTART_RESULT_SCHEMA: "chardb.packed-chat-restart-result.v1";
export declare const PACKED_CHAT_INVARIANTS: readonly string[];

export declare function parsePackedChatArgs(argv: readonly string[]): {
    readonly tarball: string;
    readonly reportPath: string | undefined;
};

export declare function buildPackedChatReport<TInvariants extends Readonly<Record<string, boolean>>>(input: {
    readonly run: object;
    readonly packageEvidence: { readonly name: string; readonly version: string; readonly tarball: object };
    readonly platform: object;
    readonly runtime: object;
    readonly identity: { readonly ownerUserId: string; readonly memberUserId: string };
    readonly organizations: {
        readonly shared: { readonly id: string };
        readonly isolated: { readonly id: string };
    };
    readonly betterAuthRoutes: readonly { readonly method: string; readonly path: string; readonly status: number }[];
    readonly benchmark: {
        readonly profile: string;
        readonly direct: {
            readonly type: "chardb-direct-select-benchmark";
            readonly profile: string;
            readonly queries: number;
            readonly concurrency: number;
        };
        readonly live: {
            readonly type: "chardb-binding-benchmark";
            readonly profile: string;
            readonly queries: number;
            readonly concurrency: number;
        };
    };
    readonly invariants: TInvariants;
}): object & { readonly invariants: TInvariants };

export declare function assertMatchingPackedChatReport<T extends object>(report: T, fingerprint: object): T;

export declare function buildPackedChatRestartHandoff(input: {
    readonly tarball: object;
    readonly owner: { readonly userId: string; readonly cookie: string };
    readonly member: { readonly userId: string; readonly cookie: string };
    readonly sharedOrganization: { readonly id: string; readonly slug: string };
    readonly producerPid: number;
    readonly expectedRows: number;
    readonly expectedRowIds: readonly string[];
    readonly betterAuthRoutes: readonly { readonly method: string; readonly path: string; readonly status: number }[];
    readonly benchmark: {
        readonly profile: string;
        readonly direct: {
            readonly type: "chardb-direct-select-benchmark";
            readonly profile: string;
            readonly queries: number;
            readonly concurrency: number;
        };
        readonly live: {
            readonly type: "chardb-binding-benchmark";
            readonly profile: string;
            readonly queries: number;
            readonly concurrency: number;
        };
    };
}): object;

export declare function assertPackedChatRestartHandoff<T extends object>(value: T, fingerprint: object): T;

export declare function buildPackedChatRestartResult(input: {
    readonly tarball: object;
    readonly identity: { readonly ownerUserId: string; readonly memberUserId: string };
    readonly organizations: {
        readonly shared: { readonly id: string };
        readonly isolated: { readonly id: string };
    };
    readonly betterAuthRoutes: readonly { readonly method: string; readonly path: string; readonly status: number }[];
    readonly invariants: Readonly<Record<string, boolean>>;
}): object;

export declare function assertPackedChatRestartResult<T extends object>(value: T, fingerprint: object): T;
