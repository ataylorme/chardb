export const GENERATED_BROWSER_CONTRACT_VERSION = "chardb.generated-browser-contract.v1";

const REQUIREMENTS = [
    {
        file: "src/auth.ts",
        test: source => source.includes('from "better-auth/plugins/organization"'),
        message: "enable Better Auth's server organization plugin",
    },
    {
        file: "src/auth.ts",
        test: source => /plugins:\s*\[[\s\S]*\borganization\s*\(/.test(source),
        message: "register organization() in defineAuth plugins",
    },
    {
        file: "src/auth.ts",
        test: source =>
            source.includes("trustedOrigins: trustedDevelopmentOrigins") &&
            source.includes('worker.protocol !== "http:"') &&
            source.includes('candidate.protocol !== "http:"') &&
            source.includes('hostname === "127.0.0.1"') &&
            !source.includes("disableOriginCheck") &&
            !source.includes("disableCSRFCheck"),
        message: "trust loopback Vite origins only for a loopback Worker without disabling origin or CSRF checks",
    },
    {
        file: "src/web/App.tsx",
        test: source => /import\s*\{\s*createAuthClient\s*\}\s*from\s*"better-auth\/react"/.test(source),
        message: "create the client with createAuthClient from better-auth/react",
    },
    {
        file: "src/web/App.tsx",
        test: source => /\borganizationClient\s*\(/.test(source),
        message: "register organizationClient() in the native Better Auth client",
    },
    {
        file: "src/web/App.tsx",
        test: source => /\bjwtClient\s*\(/.test(source),
        message: "register jwtClient() so Chardb receives Better Auth JWTs",
    },
    {
        file: "src/web/App.tsx",
        test: source => /\bauthClient\.useSession\s*\(\s*\)/.test(source),
        message: "read session state with Better Auth's native authClient.useSession() hook",
    },
    {
        file: "src/web/App.tsx",
        test: source => source.includes("anonymousSignInRequest ??=") && source.includes("Sign-in failed:"),
        message: "deduplicate anonymous sign-in and expose failures instead of hanging",
    },
    {
        file: "src/web/App.tsx",
        test: source => /\bauthClient\.useListOrganizations\s*\(\s*\)/.test(source),
        message: "read organizations with Better Auth's native authClient.useListOrganizations() hook",
    },
    {
        file: "src/web/App.tsx",
        test: source => source.includes("authClient.organization.create"),
        message: "create organizations with authClient.organization.create",
    },
    {
        file: "src/web/App.tsx",
        test: source => source.includes("authClient.organization.setActive"),
        message: "switch organizations with authClient.organization.setActive",
    },
    {
        file: "src/web/App.tsx",
        test: source =>
            source.includes("authClient.organization.delete") && source.includes('data-testid="delete-organization"'),
        message: "delete organizations with Better Auth's native organization client",
    },
    {
        file: "src/web/App.tsx",
        test: source => source.includes("activeOrganizationId"),
        message: "derive Chardb tenancy from Better Auth's activeOrganizationId",
    },
    {
        file: "src/web/App.tsx",
        test: source =>
            source.includes('fileRef("messages", "attachment")') && source.includes("useFile(messageAttachment)"),
        message: "bind the generated attachment through the browser-safe Chardb file client",
    },
    {
        file: "src/web/App.tsx",
        test: source =>
            source.includes('data-testid="message-file"') && source.includes('data-testid="message-attachment"'),
        message: "expose attachment upload and authenticated download controls",
    },
    {
        file: "src/web/App.tsx",
        test: source =>
            source.includes("replaceMessageAttachment") && source.includes('data-testid="message-replacement-file"'),
        message: "expose the transactional attachment replacement path",
    },
    {
        file: "src/web/App.tsx",
        test: source => !/from\s*["']\.\.\/schema\.ts["']/.test(source),
        message: "keep the Better Auth server schema out of the browser module graph",
    },
    ...[
        "auth-status",
        "organization-select",
        "create-organization-name",
        "create-organization-slug",
        "create-organization-submit",
        "query-state",
        "message-list",
    ].map(testId => ({
        file: "src/web/App.tsx",
        test: source => source.includes(`data-testid="${testId}"`),
        message: `expose data-testid=${JSON.stringify(testId)} for the generated browser proof`,
    })),
    {
        file: "src/web/App.tsx",
        test: source => source.split("data-organization-id={organizationId}").length - 1 >= 2,
        message: "tag the active query state and message list with data-organization-id={organizationId}",
    },
    {
        file: "src/auth.ts and src/web/App.tsx",
        test: (_source, files) => !files.authSource.includes("demo-org") && !files.appSource.includes("demo-org"),
        message: "remove the hardcoded demo-org and let Better Auth own organization ids",
    },
    {
        file: "src/web/App.tsx",
        test: source => !/function\s+(?:useAuthSession|useOrganizations)\b/.test(source),
        message: "remove local auth session and organization hook wrappers",
    },
    {
        file: "src/web/App.tsx",
        test: source => !source.includes("session.refetch"),
        message: "let Better Auth's organization client invalidate session state without a competing manual refetch",
    },
    {
        file: "src/web/App.tsx",
        test: source => !/import\s*\{[^}]*\buseSession\b[^}]*\}\s*from\s*"@chardb\/core\/react"/s.test(source),
        message: "do not import Chardb's useSession hook for Better Auth state",
    },
];

export function generatedBrowserContractFailures(files) {
    return REQUIREMENTS.filter(requirement => {
        const source = requirement.file === "src/auth.ts" ? files.authSource : files.appSource;
        return !requirement.test(source, files);
    }).map(requirement => `${requirement.file}: ${requirement.message}`);
}

export function assertGeneratedBrowserContract(files) {
    const missing = generatedBrowserContractFailures(files);
    if (missing.length === 0) return;
    throw new Error(
        [
            "The untouched generated app cannot run the Better Auth browser proof.",
            "Missing generated contract:",
            ...missing.map(item => `- ${item}`),
            "The smoke test will not patch App.tsx, auth.ts, or vite.config.ts. Update chardb init so the generated app exposes this contract.",
        ].join("\n")
    );
}
