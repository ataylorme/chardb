import { plugin } from "bun";

plugin({
    name: "chardb schema inspector Cloudflare Workers shim",
    setup(builder) {
        builder.module("cloudflare:workers", () => ({
            contents: `
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`,
            loader: "js",
        }));
    },
});
