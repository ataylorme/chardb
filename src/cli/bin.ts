#!/usr/bin/env bun
import { REAL_CONTEXT } from "./context.ts";
import { runCli } from "./run.ts";

const argv = process.argv.slice(2);
const code = await runCli(REAL_CONTEXT, argv);
process.exit(code);
