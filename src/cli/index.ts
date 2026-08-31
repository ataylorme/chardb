/** Internal modules behind the shipped `chardb` binary. */

export { runInit } from "./commands/init.ts";
export { runDoctor } from "./commands/doctor.ts";
export { runMigrate } from "./commands/migrate.ts";
export { runShards } from "./commands/shards.ts";
export { runVectorizePrepare } from "./commands/vectorize.ts";

export type { CliContext } from "./context.ts";
export { runCli } from "./run.ts";
