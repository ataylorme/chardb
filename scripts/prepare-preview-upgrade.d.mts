export declare function parsePreviewUpgradeArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly input?: string;
    readonly output?: string;
};
export declare function renderVersionTwoSchema(source: string): string;
export declare function renderVersionTwoMigrations(source: string): string;
