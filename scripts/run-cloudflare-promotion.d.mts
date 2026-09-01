export interface CloudflarePromotionOptions {
    readonly help: boolean;
    readonly tarball: string | undefined;
    readonly reactTarball: string | undefined;
    readonly worker: string | undefined;
    readonly url: string | undefined;
    readonly output: string | undefined;
    readonly privateDir: string | undefined;
    readonly migrationPrefix: string | undefined;
    readonly benchmarkSamples: number;
    readonly secretsFile: string | undefined;
    readonly adminTokenFile: string | undefined;
}

export interface WranglerVersion {
    readonly id: string;
    readonly number: number;
}

export declare function parseCloudflarePromotionArgs(argv: readonly string[]): CloudflarePromotionOptions;
export declare function parsePromotionSecrets(
    contents: string,
    adminTokenContents: string
): { readonly authSecret: string; readonly adminToken: string };
export declare function newestWranglerVersion(input: unknown): WranglerVersion;
export declare function assertFullTrafficDeployment(
    input: unknown,
    expectedVersion: string
): { readonly deploymentId: string; readonly versionId: string; readonly percentage: 100 };
export declare function wranglerVersionUploadArgs(
    worker: string,
    secretsFile: string,
    tag: string,
    message: string
): readonly string[];
export declare function wranglerVersionDeployArgs(
    worker: string,
    versionId: string,
    message: string
): readonly string[];
export declare function wranglerInitialDeployArgs(
    worker: string,
    secretsFile: string,
    tag: string,
    message: string
): readonly string[];
export declare function retryUntil<T>(
    check: () => T | Promise<T>,
    options?: { readonly timeoutMs?: number; readonly intervalMs?: number }
): Promise<T>;
export declare function classifyObsoleteControlPlane(
    status: number,
    body: unknown
): "warm-v2-catalog" | "cold-v1-journal-fence";
