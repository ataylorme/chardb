/**
 * `chardb` CLI surface. Locked commands:
 *   init / dev / doctor / explain / shards top / shards split /
 *   snapshot / restore / migrate / export / schedule {list,audit} /
 *   gsi {create,status} / vector {create,reindex}
 *
 * Output text is OPEN; exit codes and command names are CLOSED.
 */

export { runInit } from "./commands/init.ts";
export { runDoctor } from "./commands/doctor.ts";
export { runExplain } from "./commands/explain.ts";
export { runMigrate } from "./commands/migrate.ts";
export { runExport } from "./commands/export.ts";
export { runShards } from "./commands/shards.ts";
export { runSnapshot, runRestore } from "./commands/snapshot.ts";
export { runSchedule } from "./commands/schedule.ts";
export {
    applyDeployPlan,
    runDeploy,
    type ApplyDeployOptions,
    type ApplyDeployResult,
    type CloudflareApiCreds,
    type DeployInput,
    type DeployPlan,
} from "./commands/deploy.ts";

export type { CliContext } from "./context.ts";
export { runCli } from "./run.ts";
