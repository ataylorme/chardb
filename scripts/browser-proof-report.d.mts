export interface BrowserProofRoute {
    readonly method: string;
    readonly path: string;
    readonly status: number;
}

export interface BrowserProofInput {
    readonly run: { readonly id: string; readonly startedAt: string };
    readonly package: Record<string, unknown>;
    readonly platform: Record<string, unknown>;
    readonly runtime: Record<string, unknown>;
    readonly identity: { readonly userId: string };
    readonly organizations: {
        readonly first: { readonly id: string; readonly slug: string };
        readonly second: { readonly id: string; readonly slug: string };
    };
    readonly files?: Record<string, unknown>;
    readonly reshard?: Record<string, unknown>;
    readonly betterAuthRoutes: readonly BrowserProofRoute[];
    readonly invariants: Readonly<Record<string, boolean>>;
    readonly restart?: unknown;
}

export interface BrowserRestartEvidence {
    readonly schema: "chardb.browser-restart-evidence.v1";
    readonly checkpoint: "session-read-before-app-navigation";
    readonly pages: { readonly primary: "about:blank"; readonly live: "about:blank" };
    readonly process: { readonly beforePid: number; readonly afterPid: number };
    readonly origins: {
        readonly before: { readonly worker: string; readonly web: string };
        readonly after: { readonly worker: string; readonly web: string };
    };
    readonly session: {
        readonly before: {
            readonly idSha256: string;
            readonly userId: string;
            readonly activeOrganizationId: string;
        };
        readonly after: {
            readonly idSha256: string;
            readonly userId: string;
            readonly activeOrganizationId: string;
        };
    };
    readonly cookies: { readonly count: number; readonly beforeSha256: string; readonly afterSha256: string };
    readonly anonymousSignIns: {
        readonly beforeRestart: number;
        readonly afterPreNavigation: number;
        readonly afterAppNavigation: number;
        readonly freshContext: 1;
    };
    readonly freshContext: {
        readonly userId: string;
        readonly sessionIdSha256: string;
        readonly activeOrganizationId: string;
    };
}

export const BROWSER_PROOF_REPORT_SCHEMA: "chardb.packed-browser-proof.report.v1";
export const BROWSER_PROOF_REQUIRED_INVARIANTS: readonly string[];
export function assertBrowserProofInvariants<T extends object>(invariants: T): T;
export function assertBrowserProofReport<T extends object>(report: T): T;
export function assertBrowserRestartEvidence(
    value: unknown,
    identity: BrowserProofInput["identity"],
    organizations: BrowserProofInput["organizations"]
): BrowserRestartEvidence;
export function buildBrowserProofReport(input: BrowserProofInput): BrowserProofInput & {
    readonly schema: typeof BROWSER_PROOF_REPORT_SCHEMA;
    readonly suite: "packed-generated-better-auth-browser";
};
export function fingerprintFile(file: string): Promise<{
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}>;
export function writeJsonAtomically(file: string, value: unknown): Promise<string>;
