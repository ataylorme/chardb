import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    assertGeneratedBrowserContract,
    generatedBrowserContractFailures,
} from "../scripts/generated-browser-contract.mjs";

const authSource = `
import { organization } from "better-auth/plugins/organization";
function trustedDevelopmentOrigins(request?: Request): string[] {
  if (!request) return [];
  const worker = new URL(request.url);
  const candidate = new URL(request.headers.get("origin") ?? "");
  const loopback = (hostname: string) => hostname === "127.0.0.1";
  if (worker.protocol !== "http:" || !loopback(worker.hostname)) return [];
  if (candidate.protocol !== "http:" || !loopback(candidate.hostname)) return [];
  return [candidate.origin];
}
defineAuth({ plugins: [organization()], trustedOrigins: trustedDevelopmentOrigins });
`;

const appSource = `
import { createAuthClient } from "better-auth/react";
import { createChardbReactClient } from "@chardb/react";
organizationClient();
jwtClient();
const workerUrl = window.location.origin;
const db = createChardbReactClient({
  url: workerUrl,
  ownership: "organization",
  auth: ({ baseURL }) => createAuthClient({ baseURL }),
});
db.auth.useSession();
anonymousSignInRequest ??= db.auth.signIn.anonymous();
const authFailure = "Sign-in failed:";
db.auth.useListOrganizations();
db.auth.organization.create({ name, slug });
db.auth.organization.setActive({ organizationId });
db.auth.organization.delete({ organizationId });
const organizationId = session.data.session.activeOrganizationId;
const messageAttachment = fileRef("messages", "attachment");
db.useFile(messageAttachment);
attachment.upload({ file, idempotencyKey });
attachment.downloadUrl({ rowId });
db.useQuery(listMessages, { limit: 50 });
db.useMutation(postMessage);
replaceMessageAttachment();
<output data-testid="auth-status" data-user-id={userId} />;
<select data-testid="organization-select" />;
<input data-testid="create-organization-name" />;
<input data-testid="create-organization-slug" />;
<button data-testid="create-organization-submit" />;
<button data-testid="delete-organization" />;
<code data-testid="query-state" data-organization-id={organizationId} />;
<section data-testid="message-list" data-organization-id={organizationId} />;
<input data-testid="message-file" />;
<a data-testid="message-attachment" />;
<input data-testid="message-replacement-file" />;
`;

describe("generated Better Auth browser contract", () => {
    test("accepts the native organization UI contract", () => {
        expect(() => assertGeneratedBrowserContract({ authSource, appSource })).not.toThrow();
        expect(generatedBrowserContractFailures({ authSource, appSource })).toEqual([]);
    });

    test("reports every missing scaffold requirement without patching around it", () => {
        const incomplete = {
            authSource: 'defineAuth({ plugins: [anonymous()] }); const id = "demo-org";',
            appSource: 'authClient.signIn.anonymous(); const id = "demo-org";',
        };
        const failures = generatedBrowserContractFailures(incomplete);
        expect(failures).toContain("src/auth.ts: enable Better Auth's server organization plugin");
        expect(failures).toContain("src/web/App.tsx: create the client with createAuthClient from better-auth/react");
        expect(failures).toContain("src/web/App.tsx: switch organizations with db.auth.organization.setActive");
        expect(failures).toContain(
            "src/auth.ts and src/web/App.tsx: remove the hardcoded demo-org and let Better Auth own organization ids"
        );
        expect(() => assertGeneratedBrowserContract(incomplete)).toThrow(
            "The smoke test will not patch App.tsx, auth.ts, or vite.config.ts"
        );
    });

    test("rejects competing local and Chardb session hooks", () => {
        const wrappers = `${appSource}\nfunction useAuthSession() {}\nfunction useOrganizations() {}`;
        expect(generatedBrowserContractFailures({ authSource, appSource: wrappers })).toContain(
            "src/web/App.tsx: remove local auth session and organization hook wrappers"
        );
        const chardbSession = `${appSource}\nimport { useSession } from "@chardb/react";`;
        expect(generatedBrowserContractFailures({ authSource, appSource: chardbSession })).toContain(
            "src/web/App.tsx: do not import Chardb's useSession hook for Better Auth state"
        );
    });

    test("keeps the archived conformance UI on Better Auth's native React session hook", () => {
        const source = readFileSync(
            path.resolve(import.meta.dir, "../example/chat/conformance/src/web/App.tsx"),
            "utf8"
        );

        expect(source).toContain('import { createAuthClient } from "better-auth/react"');
        expect(source).toContain("authClient.useSession()");
        expect(source).not.toContain('useSession } from "@chardb/react"');
        expect(source).not.toContain("function useAuthSession");
    });
});
