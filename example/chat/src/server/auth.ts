import { defineAuth } from "@chardb/core/server";
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

function trustedDevelopmentOrigins(request?: Request): string[] {
    if (!request) return [];
    try {
        const worker = new URL(request.url);
        const candidate = new URL(request.headers.get("origin") ?? request.headers.get("referer") ?? "");
        const loopback = (hostname: string) =>
            hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
        if (worker.protocol !== "http:" || !loopback(worker.hostname)) return [];
        if (candidate.protocol !== "http:" || !loopback(candidate.hostname)) return [];
        return [candidate.origin];
    } catch {
        return [];
    }
}

export const auth = defineAuth({
    appName: "chardb-chat-tutorial",
    plugins: [anonymous(), organization(), jwt()],
    trustedOrigins: trustedDevelopmentOrigins,
});
