import { defineMigrations, defineSchemaBaseline } from "@chardb/core/server";
import { auth } from "./auth.ts";
import * as schema from "./schema.ts";

export const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "cloudflare_vectorize_proof_initial_schema",
        domainSchema: schema,
        authOptions: auth.options,
    }),
]);
