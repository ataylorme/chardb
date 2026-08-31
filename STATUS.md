# Status

Chardb is a working experimental database for Cloudflare Workers. Better Auth organizations own the data, Drizzle defines the schema, SQLite Durable Objects execute transactions, and the browser SDK provides live queries. R2 files and Vectorize search use the same organization boundary.

The supported path is deliberately narrow:

- `forOrg()` for organization data and `forOrgUser()` for private rows inside an organization;
- registered mutations and bounded Drizzle selects through one query executor;
- resumable, forward-only additive migrations;
- authenticated file upload and download through R2;
- transaction-bound vector changes with filtered Vectorize search;
- local development and tests through Wrangler, Miniflare, and Cloudflare's Vitest integration;
- `wrangler.toml` by default, with existing JSONC projects accepted by the CLI.

The npm package exports `@chardb/core`, `/server`, `/react`, `/files`, and `/vite`. The Rust workspace contains the separate `chardb-client` protocol client.

## What is tested

The repository tests schema policy, authorization changes, mutation replay, live-query recovery, migration interruption, files, vectors, range movement, package exports, generated projects, real Workerd execution, and browser behavior. Release workflows repeat the packed artifact on Linux, macOS, Windows, Miniflare, and disposable Cloudflare resources.

Run the normal local checks with:

```bash
bun run typecheck
bun run lint
bun run test
bun run test:docs
```

Benchmarks report workload identity, sample counts, warmup, timing, throughput, and correctness. Local and deployed numbers are kept separate. Total deployed cost is still unmeasured. See [COST.md](COST.md) for the Cloudflare billing model and [OPERATIONS.md](OPERATIONS.md) for failure handling.

## Limits

Do not use Chardb as the only home for production data yet. It has no supported backup, export, restore, point-in-time recovery, replica promotion, regional failover, or SLA. Range movement is an experimental operator command, not automatic resharding.
