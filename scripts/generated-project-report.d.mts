export declare const GENERATED_PROJECT_REPORT_SCHEMA: "chardb.generated-project.report.v1";
export declare const GENERATED_PROJECT_INVARIANTS: readonly string[];

export declare function parseGeneratedProjectArgs(argv: readonly string[]): {
    readonly tarball: string;
    readonly reportPath: string | undefined;
};

export declare function buildGeneratedProjectReport<TInvariants extends Readonly<Record<string, boolean>>>(input: {
    readonly run: object;
    readonly packageEvidence: {
        readonly name: string;
        readonly version: string;
        readonly tarball: object;
    };
    readonly platform: object;
    readonly runtime: object;
    readonly migrations: {
        readonly initial: {
            readonly id: string;
            readonly targetVersion: number;
            readonly activatedShards: readonly string[];
        };
        readonly upgrade: {
            readonly id: string;
            readonly fromVersion: number;
            readonly targetVersion: number;
            readonly activatedShards: readonly string[];
        };
    };
    readonly invariants: TInvariants;
}): object & { readonly invariants: TInvariants };

export declare function assertMatchingGeneratedProjectReport<T extends object>(report: T, fingerprint: object): T;
