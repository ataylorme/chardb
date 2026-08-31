import { defineMigrations } from "@chardb/core/server";
import { initialSchema } from "./migrations/v1.ts";

export const migrations = defineMigrations([initialSchema]);
