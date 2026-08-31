import { defineAuth } from "@chardb/core/server";
import { anonymous } from "better-auth/plugins/anonymous";
import { bearer } from "better-auth/plugins/bearer";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

export const auth = defineAuth({
    appName: "chardb-cloudflare-vectorize-proof",
    plugins: [anonymous(), bearer(), organization(), jwt()],
});
