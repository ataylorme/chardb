/**
 * Browser-build stand-ins for the two workerd base classes imported by the
 * server package. The SPA never instantiates them. They exist only so Vite can
 * finish resolving the shared query-handle module graph before tree-shaking.
 */
export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
        this.ctx = ctx;
        this.env = env;
    }
}

export class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: ExecutionContext;

    constructor(ctx: ExecutionContext, env: Env) {
        this.ctx = ctx;
        this.env = env;
    }
}
