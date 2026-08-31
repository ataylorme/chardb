export interface GeneratedBrowserContractSources {
    readonly authSource: string;
    readonly appSource: string;
}

export const GENERATED_BROWSER_CONTRACT_VERSION: "chardb.generated-browser-contract.v1";
export function generatedBrowserContractFailures(files: GeneratedBrowserContractSources): string[];
export function assertGeneratedBrowserContract(files: GeneratedBrowserContractSources): void;
