# chardb

Cloudflare-native SQL with per-tenant ACID and live Drizzle queries.

> chardb is the database for Cloudflare-native apps: SQL, files, vectors, search, scheduling, real-time, presence, and auth — one Drizzle schema, one client, one bill.

This repository is the technical foundation: a deterministic FK-chain colocation
algorithm, Vitess-style 16,384-vshard range routing, an op-log-backed at-most-once
mutation pipeline, and a hibernated WebSocket gateway with cookie-aligned live
queries. The locked public surface lives under `chardb`, `chardb/server`,
`chardb/drizzle`, `chardb/files`, `chardb/auth`, `chardb/react`, and
`chardb/cli`; everything else is implementation that may evolve between minor
releases.

## Getting started

```bash
bun install
bun test
```

## Package layout

- `chardb` — client, types, error codes
- `chardb/server` — `defineChardb`, `defineAuth`, `createApi`, `defineMutation` / `defineQuery` / `definePresenceKey`, the access-control DSL (`tenantScope` / `ownerScope` / `requireRole` / `requirePermission` / `publicRead` / `createAccessControl` lifted from better-auth), `manifestFromExports`, `mountChardb`, scatter-gather helpers (`mergeTopK` / `mergePartialAggregates`), and the Durable Object base classes wrangler binds (`Cdb`, `Catalog`, `Gateway`, `BlobMeta`, `Resharder`, `GsiShard`)
- `chardb/drizzle` — async SQLite driver
- `chardb/files` — `file()` / `fileArray()` Drizzle column types + validator adapters (`chardb/files/{zod,typebox,valibot,arktype}`)
- `chardb/auth` — `defineAuth` / `synthesizeAuthSchema` for the auth-table namespace; `withChardb` for wrapping an existing better-auth DBAdapter with epoch dispatch
- `chardb/react` — `ChardbProvider`, `useQuery`, `useMutation`, `usePresence`
- `chardb/observability` — tail-Worker scaffolding (`defaultChardbTail`, `renderTailWrangler`, sinks)
- `chardb/reshard` — pure-helper trigger DDL + row-apply renderers (exercised through bun:sqlite)
- `chardb/cli` — `chardb` binary (`init` / `doctor` / `migrate` / `deploy` are wired; `shards` / `export` / `schedule` print foundation-skeleton output today)
- `chardb/vite` — Vite plugin (function-ref → wire id mapping; partial schema-HMR via a `chardb:schemaChanged` dev-server event)
- `chardb/miniflare-plugin` — dev-time Miniflare plugin (cron simulator + Vectorize stub shipped)
- `chardb/eslint-plugin` — `chardb/explain-strict` rule + recommended config

## Vocabulary

- **partition / partitionKey / `.partitionedBy()` / `CDB_CROSS_PARTITION`** — user contract.
- **shard / shard DO / vshard** — operator/internals; physical placement.
- **chardb** — brand and npm package. **`CDB_`** — error-code prefix.
