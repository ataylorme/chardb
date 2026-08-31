import { defineAuth } from "@chardb/core/server";
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

export const auth = defineAuth({
    appName: "chardb-cloudflare-file-proof",
    plugins: [anonymous(), organization(), jwt()],
});
