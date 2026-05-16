# chardb — handoff

Running engineering note for the chardb foundation. Not user-facing docs.

## Recent: chardb-native better-auth integration cutover

Landed in this pass (full cutover, no backwards compat):

- `src/auth/runtime.ts` — module-level `bindAuthRuntime({schema, options})` so Cdb / Catalog DOs can resolve model→Drizzle table + partition rule (`tenant`/`principal`/`replicated`) at runtime. Wired from `mergeAuthIntoSchema` so any `defineChardb({auth})` populates it lazily.
- `src/auth/sql.ts` — `authCreate/authUpdate/authDelete/authFindOne/authFindMany/authCount` rendering parameterized SQLite against the `SyncSql` adapter (no Drizzle runtime; Drizzle is the schema source via `getTableColumns`).
- `Cdb.mutateAuth/queryAuth` (`src/server/do/cdb.ts`) and `Catalog.mutateAuth/queryAuth` (`src/server/do/catalog.ts`) — partition-pinned vs replicated execution venues. Both DOs `CREATE TABLE IF NOT EXISTS` the relevant synthesized auth tables on bootstrap (DDL rendered from `getTableConfig`).
- `src/auth/chardb_adapter.ts` — `chardbAuthAdapter({env, dispatcher?})` returns an `AdapterFactory<BetterAuthOptions>` via `createAdapterFactory`. Routes by `placementFor(model)`; bumps `auth_epoch_*` per model rule. Where-translation supports `eq`+AND only — extend `whereToFlat` for richer operators when a plugin needs them.
- `chardb({auth})` auto-mounts `/api/auth/*` (see `buildDefaultAuthHandler` in `src/server/chardb.ts`) — memoizes a per-env `betterAuth({...auth.options, database: chardbAuthAdapter({env})})`. Caller-supplied `authHandler` still wins.
- JWT verification: `src/auth/jwt.ts#verifyJwt` (jose-backed) + `src/auth/jwks_cache.ts#createCatalogJwksResolver` (SWR-cached against `Catalog.{getJwk,putJwk}`).
- `Gateway.onHello` extracts `{principalId, tenantId, role, jwtExp, claims}` from the JWT and stashes them on the WS attachment. `routeMut` packages a `GwAuthEnvelope` and forwards it on `runMutation`. (Actual `ctx.auth` population at the shard execution layer is the remaining gap — see "Known runtime gaps" below.)
- React: `ChardbProvider auth={authClient}` derives `getJwt` from `authClient.$fetch("/token")`. `useSession()` projects better-auth's nanostores `useSession` atom (via `useSyncExternalStore`) into `{userId, tenantId, isPending, raw}`.
- Example chat (`example/chat`): bot-token plugin + e2e deleted; `audit_events`, `messages.score`, `messages.botTokenId`, `searchMessages` deleted; `api.ts` split into `api.ts` (mutations + policies) and `queries.ts` (queries + intent extractors); `App.tsx` rewritten to `createAuthClient` + `<ChardbProvider auth={authClient}>` + anonymous flow with demo-org bootstrap via `defineAuth({databaseHooks})`; `postMessage` reads `organizationId`/`authorId` from `ctx.auth` (security fix); `useChatMessages` uses the new `useQuery(handle, args)` overload.
- New tests: `test/auth/runtime.test.ts` covers placement rules + bun:sqlite-backed CRUD round-trips for the SQL helpers.

### Known runtime gaps still pending

1. **Mutation execution wiring on the Cdb shard.** `Cdb.mutate(args, runner)` accepts a runner closure but the Gateway's `routeMut` calls a type-asserted `shard.mutate({ref, mutId, args})` shape that doesn't match. Until those signatures are unified (Cdb resolves the runner from its own access to the manifest), user mutations don't actually execute end-to-end. The auth-write path (`Cdb.mutateAuth`) bypasses this entirely because the chardb adapter dispatches DO methods directly.
2. **`ctx.auth` population at execution time.** The envelope is threaded through `runMutation(input.auth)` but the actual `MutationCtx { db, auth }` constructor that hands `auth` to handlers is part of (1).
3. **Cross-partition GSI lookups.** `chardbAuthAdapter.findOne` raises `CDB_AUTH_GSI_MISS` when the where-clause doesn't include the partition column. The four core models always do, but a user plugin with `email`-only lookups will need GSI shards (W0.3 deferred — Vite plugin emission of `BUILT_IN_AUTH_GSIS`).
4. **Adapter `transaction` is `false` today.** Better-auth wraps its own multi-write paths in `await chardbAdapter.transaction(...)`; we set `transaction: false` so it falls back to sequential writes. The single-partition single-`Cdb.mutate` form from the plan slots in once (1) is wired.

## Status

- TypeScript strict (incl. `exactOptionalPropertyTypes`) clean: `bunx tsc --noEmit` ✓
- `bun test` (root) — **323 pass / 3 skip / 0 fail across 42 files** (~72k expect calls; includes the original stress / reshard / wire / walker / colocation / dialect / observability suites; `test/auth/synthesize.test.ts` covering the synthesizer and `defineAuth` inference (now bundling `organization()` and `admin()` by default); `test/server/cdb-table.test.ts` covering the schema-first RLS+CLS surface end-to-end (forOrg/forUser/globalScope factories, tenant column auto-discovery, ambiguity / missing-FK error codes, selfBy + column-matrix compilation, PolicyDefinition emission parity, column mask + writability checks including autoFilled-bypass, AccessControl materialization with `user:` prefix routing); `test/server/chardb.test.ts` covering the `chardb({…})` mega-factory's route fall-through, lazy `.schema` getter (preserved post-cdbTable wiring), inline-options auth, and DO-class direct fields; `test/workerd/catalog.harness.test.ts` and `test/workerd/reshard.harness.test.ts` driving real DO SqlStorage via miniflare@4).
- `bun test` (example/chat) — **17 pass / 0 fail across 6 files** (≈2k expect calls, deterministic xorshift seeds): chat app exercising op-log idempotency at 1000 mutations × 50 partitions, intent-routing for 100 representative Drizzle queries, scatter-gather merge correctness vs a naive reference, row-level policy isolation across 1500 mixed-tenant rows, full reshard pipeline through bun:sqlite triggers + `renderRowApply` against a destination DB, and the end-to-end custom better-auth plugin (`bot-token`) coverage that validates auth-table inference and FK resolution through `messages.botTokenId` → `auth.botToken.id`.
- `bun run build` (unbuild) — produces every subpath export under `dist/` (~428 kB), including the `chardb/reshard`, `chardb/eslint-plugin`, and `chardb/observability` entries.
- All locked decisions reflected in code and types
- All inline plan-document citations have been removed from source; surviving references in code comments are public URLs (workerd, drizzle-orm, better-auth, Cloudflare docs, RFCs, MDN)
- TLA+ specs for the PITR barrier protocol and Resharder phase machine live in `spec/`

## Layout

```
src/
  index.ts                       chardb (client + types + error codes)
  errors.ts                      CdbErrorCode enum + CdbError + isRetryable
  types.ts                       branded ids (Cookie, MutId, ClientId, …)
  wire.ts                        protocolV:1 envelope, Up/Down, MutResult
  intervals.ts                   IntervalSet + IntervalMap
  intervals_wire.ts              wire ↔ runtime interval encoding
  vshard.ts                      VshardMap (Vitess-style range table) + xxhash64 of cols
  hash/xxhash64.ts               pure-TS XXH64
  util/canonical.ts              stableJson + stableHashHex + sha256 + bytesEq
  oplog/                         _chardb_op_log schema + wrapper + envelope
  colocation/                    deterministic FK-chain SCC algorithm + property tests
  drizzle/dialect.ts             SQLiteAsyncDialect subclass that stashes CdbIntent
  drizzle/walker.ts              StaticIntentExtractor: where → CdbIntent
  client/                        WS reconnect + cookie carryover + cross-tab BroadcastChannel
  files/                         file()/fileArray() Drizzle customType
  files/validators/{zod,typebox,valibot,arktype}.ts
  vector.ts                      vector() + inlineVector() + cosineSimilarity
  auth/                          better-auth DBAdapter wrapper, profile checker, partition-key overrides
  react/                         ChardbProvider, useQuery, useMutation, useSession, usePresence, useStream, useVectorSearch, useUpload
  observability/                 normalizeTailItem + tailHandler + analyticsEngineSink + httpSink + defineTailWorker
  reshard/                       trigger DDL renderer + row apply renderer + range filter (pure helpers, exercised end-to-end against bun:sqlite)
  eslint-plugin/                 chardb/explain-strict rule + recommended config
  server/
    index.ts                     public surface
    define.ts                    defineMutation/defineQuery/defineCron/defineStream/defineGsi/definePresenceKey
    ledger.ts                    defineLedger
    logpush.ts                   renderLedgerLogpush + renderLedgerPayload
    dt.ts                        crossPartitionMutation + DT_DDL (v1.1 scaffold; raises CDB_DT_NOT_IMPLEMENTED)
    manifest.ts                  manifestFromExports + resolveMutation (bundler-emitted registry)
    policy.ts                    chardbPolicy
    refs.ts                      __chardbRef function-identity helpers
    entrypoint.ts                defineChardb / mountChardb / runMutation RPC + scheduled() PITR + user-cron fanout
    chardb.ts                    chardb({…}) mega-factory — one call composes defineAuth + defineChardb + Hono + mountChardb + the six DO classes into the wrangler-ready module (kept defineAuth/defineChardb/mountChardb public as the lower-level primitives)
    do/cdb.ts                    Cdb shard DO (SQLite + transactionSync + op-log wrapper + IntervalMap + barrierBookmark)
    do/catalog.ts                Catalog DO (range table, epochs, JWKS SWR, openBarrier/ackBarrier/openBarriers, atomic cutover)
    do/gateway.ts                Gateway DO (Hibernatable WS + sub registry + presence + onMut routing)
    do/blobmeta.ts               BlobMeta DO (refcount + status lifecycle)
    do/resharder.ts              Resharder DO (RESHARDER_PHASE enum, CAS advance, abort, getPhase, runSplit driver)
    do/gsishard.ts               GsiShard DO (parallel partition map per defineGsi)
    do/sql_adapter.ts            SqlStorage → SyncSql adapter
    merge.ts                     scatter-gather: mergeTopK / mergePartialAggregates / mergeDistinct
    policy.ts                    chardbPolicy + applyPoliciesToWhere + applyRowPolicies + policyDigest
  cli/                           chardb init / doctor / explain / shards / snapshot / restore / migrate / export / schedule / deploy
  vite/                          @chardb/vite-plugin (function-ref → wire id, virtual modules, schema HMR)
  miniflare-plugin/              dev-only Miniflare external plugin (cronMatches + runCronSimulator + chardbMiniflarePlugin shipped; DO storage outside tests is still upstream work)
spec/                            TLA+ specs (Barrier.tla, Resharder.tla, *.cfg, README.md)
test/                            bun test suites
build.config.ts                  unbuild
```

## What's next (in priority order)

Three subagent audits ran in parallel this session — type-safety, test coverage, and an end-to-end example/chat demo. Below the survivors that didn't ship in this round, ranked.

### From the type-safety audit (closed this session)

- **`decodeWire` hardened** — now JSON-parses with a try/catch, rejects non-objects, and validates the `t` tag against closed `UP_TAGS` / `DOWN_TAGS` whitelists exported from `src/wire.ts`. New `checkProtocolV(advertised)` returns a `mustRefetch:protocolMismatch` envelope for any mismatched outer version.
- **`ChardbRef` brand constructor validates format** — empty strings or refs missing `#` throw `TypeError`. `definePresenceKey` now mints `presenceKey#…` refs to satisfy the format.
- **`defineCron` actually invokes** — the returned `CronFn`'s `invoke()` calls the handler/mutation with `args` (degraded undefined ctx for plain handlers); on error logs at the chardb namespace; the entrypoint's `runUserCrons` still drives the dispatch loop.
- **Vite plugin** — replaced `require("typescript")` with `createRequire(import.meta.url)`.
- **Manifest cast cleanup** — preserves the user handler's `Function.name` on the wrapper so dev-mode `autoRef` doesn't collapse all helpers to `mutation#fn`.
- **Client `SubRecord` unified** — listener storage is now `(rows: RawJson[]) => void`; `subscribe<TRow>` wraps the user listener once on entry rather than threading a generic through the map.
- **`ledger` ref kind** — dropped `"ledger" as never`; `ledger` is in the `ChardbFunctionKind` union.
- **`Gateway.onSub`** — added `principalId` field to the `serializeAttachment` envelope; introduced `errorCodeFrom(e)` that prefers a real `CdbError.code`, falls back to a regex match on `Error.message`, then to `CDB_SHARD_UNAVAILABLE`. No more `as never` on the error path.

### From the type-safety audit (closed in a follow-on session)

- **`SqlValue` row affinity vs JSON columns** — `chardb/oplog/wrapper.ts` ships a `JsonText` brand and a pure `parseJsonColumn(name, value)` helper that returns a typed `Record<string, RawJson>` (or `null` for the empty/unset case) and throws `TypeError` on malformed JSON or non-object roots. `_chardb_split_log.before`/`after` are now declared `JsonText | null` on `TailEntry`; `Cdb.applyTailBatch` parses through the helper, so trigger corruption fails loudly rather than silently re-applying garbage. 5 tests in `test/oplog/json_column.test.ts`.
- **`GwAttachment.principalId` is wired and now written** — `chardb/auth/jwt.ts` adds a pure unverified JWT decoder (`decodeJwtClaims` + `principalIdFromJwt` + `base64UrlDecode`) that rejects malformed/expired tokens and projects the `sub` claim into a `PrincipalId` brand. `Gateway.onHello` populates `attachment.principalId` from the inbound `msg.jwt`; `onSub` keeps the clientId-projection fallback for unauthenticated traffic, with the comment now stating the contract precisely (write paths re-validate authority). Signature verification against `catalog_jwks` is the next layer up — the `kid` is captured from the header so that step can find the matching key without a second decode pass. 13 tests in `test/auth/jwt.test.ts` cover empty/malformed inputs, expiry, non-object claims, base64-URL-safe decoding, and `sub`-projection edge cases.

### Closed this session

- **Manifest TArgs → RawJson** (`src/server/manifest.ts`) — decision documented inline: the manifest sits at the wire boundary (post-`decodeWire`, pre-RPC), so erasing `TArgs` to `RawJson` here is the type we actually have. A phantom-map alternative was rejected because TS lacks generic existentials. Validation lives one level up in the user's handler via `chardb/files/{zod,typebox,valibot,arktype}`.
- **`Gateway.routeMut` wire-code validation** — `result.error.code` is now narrowed via `isCdbErrorCode`, with `CDB_INVARIANT` as the typed fallback for codes outside the closed set.

### From the test-suite audit (closed this session)

- **Wire envelope coverage** — `decodeWire` has tests for malformed JSON, non-object payloads, missing-tag, unknown-tag, and disjoint UP/DOWN tag sets; `checkProtocolV` covered for `1`, `2`, `"1"`, and `undefined`.
- **Op-log eviction path** — `test/oplog/wrapper.test.ts` plants a row with empty `payload_enc` and asserts the second call raises `CDB_TXN_ABORTED_EVICTION` with `retryable: true`.
- **Reshard pipeline integration** — `test/reshard/integration.test.ts` covers INSERT→UPDATE→DELETE→INSERT cycles, out-of-range filtering, idempotent re-replay, and multi-table no-contamination through real bun:sqlite triggers.
- **CDB error surface** — `test/errors_surface.test.ts` sweeps every `CDB_ERROR_CODES` entry asserting docs URL format + retryable polarity + monomorphic `toJSON`.
- **`routeMutation`** — `test/server/route_mutation.test.ts` covers `singlePartition`-without-`partitionKey` → `CDB_CROSS_PARTITION` envelope, unknown-ref → `CDB_REF_NOT_FOUND`, idempotent partitioning.
- **Walker operator fallback** — `test/drizzle/walker.test.ts` now covers `lt`/`gte` on partition column plus the cross-partition fallback for `ne`/`isNull`/`isNotNull`/`notInArray`/`not(and)`.
- **Drizzle dialect** — `test/drizzle/dialect.test.ts` covers `attachIntent`/`getIntent` symbol round-trip, JSON-stringify non-leak, and `CdbDialect.buildIntent` dispatch.
- **Composite partition keys** — `test/vshard.test.ts` covers unicode (`café`/`🚀`), bigint↔number coercion, `Uint8Array`, column ordering, unsupported scalars, and empty-key.
- **Client wire round-trip** — `test/client.test.ts` drives `createChardbClient` against an in-process FakeWS for hello/sub/poke/mutate/mustRefetch/close, plus reconnect within the 30s RYW window resuming from `lastCookie` and reconnect *after* expiry (via `setSystemTime`) dropping the cookie so the server emits `mustRefetch{lagged}`.
- **React hooks lifecycle** — `test/react.test.tsx` (via `react-test-renderer`) covers `useQuery` mount→subscribe→patch→unmount-disposer, `useMutation` invoking `client.mutate(fn.__chardbRef, args)`, and `useChardb` outside `<ChardbProvider>` throwing. Caught and fixed a pre-existing bug where `ChardbProvider` returned a hand-rolled fake `ReactElement` that React 18's reconciler rejected; replaced with `createElement(ChardbCtx.Provider, …)`.
- **Resharder crash-resume** — `test/reshard/integration.test.ts` simulates a crash mid-bulk, accepts concurrent writes during the crash window, and asserts the per-lsn duplicate-detection set proves no row was applied twice.
- **`applyDeployPlan` against Cloudflare Logpush** — `src/cli/commands/deploy.ts::applyDeployPlan` POSTs each rendered Logpush job to `accounts/:id/logpush/jobs` with bearer auth. Idempotent on `name` (auto-fetches existing job list, or accepts a pre-fetched set). `fetch` is injectable. `test/cli/deploy.test.ts` covers POST shape, idempotent skip, auto-fetch, error surfacing, and `apiBase` override.
- **2PC v1.1 protocol** — `src/server/dt_protocol.ts` implements the coordinator/participant state machine (`preparing → committed/aborted`) against `SyncSql` plus a `Participant` RPC contract. `src/server/dt.ts::crossPartitionMutation` now routes through `runCoordinator` when a `DtRuntime` is bound (raises `CDB_DT_NOT_IMPLEMENTED` otherwise). Recovery follows presumed-abort: any `unknown` participant vote aborts. `test/server/dt_protocol.test.ts` exercises the full surface: happy commit, no-vote abort, prepare-throws abort, missing-binding abort, recovery-from-preparing (both committed and presumed-abort), idempotent recovery from terminal state, openDt invariants, and the new `CDB_DT_ABORTED` wire code.
- **Cron simulator dev driver** — `chardb/miniflare-plugin::runCronSimulator` walks every registered `defineCron` handle through a synthetic UTC time range (default 1h, 60s steps), firing handlers at every minute where `cronMatches(handle.__chardbCron, t)` is true. Returns a deterministic `{ fires, stepsEvaluated }` report. Default `invoke` runs handlers sequentially; tests pass an override to record fires without re-running the handler. 5 simulator tests cover every-minute fanout, `*/15` quarterly cadence, multi-handle independence, sequential awaiting, and stepMs/range invariants.
- **Workerd reshard harness** — `test/workerd/reshard.harness.test.ts` boots `miniflare@4` with a bundled test worker (`test/workerd/worker.entry.ts` exports `TestCdb extends Cdb` so the harness can call `_exec`/`_dump` for setup/inspection without polluting the production class). The end-to-end test seeds a source DO, runs `beginReshardSource` to install triggers, performs additional inserts and an UPDATE that go to `_chardb_split_log`, then drives `bulkCopyBatch → applyBulkBatch → readTailBatch → applyTailBatch` until both shards converge. A second test asserts `applyBulkBatch` defensively filters out-of-range rows so a misrouted batch can't pollute the destination. Bundle is built via `bun build` CLI (Bun.build's API drops relative `.ts` imports under the test runner) and gitignored at `test/workerd/.test-worker.bundle.mjs`.
- **Workerd Catalog barrier harness** — `test/workerd/catalog.harness.test.ts` runs the PITR barrier flow (`openBarrier` → `ackBarrier` → `openBarriers`) against a real `Catalog` Durable Object via miniflare@4. Covers expected-shards seeding from the range table, idempotent re-acks, multi-shard incomplete-barrier accounting (after a `cutover`-synthesised second shard), and silent no-op for an unknown `barrierId`. Pairs with the pure-helper `selectMatchingCrons` test covering exact-string cron dispatch in `runUserCrons` — together they finish the `Server-Timing + correlationId in entrypoint` portion of the observability TODO.
- **Default `chardb-tail` Worker** — `chardb/observability` now ships `defaultChardbTail()`, `resolveTailSink(env)`, `consoleSink()`, and `renderTailWrangler()`. The default tail Worker resolves `CHARDB_TAIL_AE` (Analytics Engine) → `CHARDB_TAIL_URL` + optional `CHARDB_TAIL_AUTH` (HTTP ndjson) → `console.log` ndjson in deterministic order, so a customer's tail Worker is a one-liner: `export default defaultChardbTail()`. `renderTailWrangler` emits a complete `wrangler.jsonc` for the sibling `chardb-tail` service the chardb Worker's `tail_consumers` already targets. 5 new tests in `test/observability.test.ts`.

### From the test-suite audit (still open)

3. **Workerd-level resharder** — pure-helper crash-resume is now covered (`test/reshard/integration.test.ts`: persisted cursor + concurrent writes during the crash window + no-duplicate-application invariant). What's still missing is the workerd harness running `runSplit` end-to-end against real DO `SqlStorage`.
4. **`react-test-renderer` is React 18.x** — pinned alongside `react@18.3.1`. If `react` peer is bumped to 19, this test-only dep needs to follow.

### Production-runtime work — closed this session

17. ~~**Workerd integration tests for the Cdb reshard surface**~~ — covered by `test/workerd/reshard.harness.test.ts` (end-to-end bulk + tail through real DO `SqlStorage`).
18. ~~**Miniflare bindings wiring**~~ — `runCronSimulator` lands in `chardbMiniflarePlugin` for the dev cron driver; the workerd harnesses cover DO `SqlStorage` integration. Full external-plugin integration (DO storage *outside* of tests) is still upstream work; nothing more to do at the chardb layer.
19. ~~**`chardb deploy` runtime**~~ — `applyDeployPlan` POSTs Logpush jobs idempotently with bearer auth; tail-consumer wrangler.jsonc render lands in `chardb/observability::renderTailWrangler` so the user's CI can `wrangler deploy` the sibling service before `applyDeployPlan` runs.
20. ~~**2PC v1.1 implementation**~~ — `server/dt_protocol.ts` is the coordinator + participant protocol against `_chardb_dt_state` / `_chardb_dt_participant`, with presumed-abort recovery and 13 protocol tests.

## Reference — running

```bash
bun install
bun test                                       # 304 pass / 3 skip (root)
bunx tsc --noEmit                              # strict typecheck
bun run build                                  # unbuild → dist/
bun run src/cli/bin.ts init my-app             # smoke test the CLI
cd example/chat && bun test test/e2e/          # 13 pass — chat-app E2E stress
java -jar tla2tools.jar -config spec/Barrier.cfg spec/Barrier.tla     # TLC model check
```

## Example app

`example/chat/` is a focused, real chardb app split into `src/server/`
(Drizzle schema + `defineMutation`/`defineQuery`/`definePresenceKey` + Worker
entry) and `src/web/` (`<ChardbProvider>` + React hooks against the
chardb live-query SDK). The headline shape is **better-auth built in**:
the example never declares its own `organizations` table — `src/server/worker.ts`
(everything chardb-shaped lives in the Worker entry, no side `auth.ts`)
calls `defineAuth({ plugins: [organization(), botToken()] })` and chardb
returns the single `auth` object the domain schema FKs into. Plugin tables
are inferred from the `plugins` tuple via `InferPluginTables<TPlugins>`
(reads each plugin's `schema` keys), and *column names* for each plugin
table are inferred via `FieldsOfPluginTable<TPlugins, T>` (reads
`schema[T].fields` keys). The core four (`user`, `session`, `account`,
`verification`) come from the static `KnownAuthTables` map in
`src/auth/synthesize.ts`. Everything plugin-contributed — including
user-authored plugins like `src/server/plugins/bot-token.ts` (≈25 LoC,
`satisfies BetterAuthPlugin`) — goes through the same code path:
`auth.botToken.token`, `auth.organization.slug`, `auth.member.role`
all resolve to typed Drizzle columns without a `getTableColumns`
round-trip, and dropping a plugin makes its tables a TS error at every
call site. `test/e2e/e2e_custom_plugin.test.ts` proves the path
end-to-end through `getAuthTables` + FK resolution + per-column type
assertions. The auth-table namespace is
reserved by chardb; `assertNoReservedTableShadow` raises
`CDB_RESERVED_TABLE_NAME` if a domain table shadows one.
`chardb({ auth, schema, api })` — the **single-call factory in
`src/server/chardb.ts`** — composes the wrangler-ready Worker module
top to bottom. It reads `auth.options`, runs `defineChardb` (which
merges the synthesized auth tables into the runtime schema, walks the
`api` namespace for `__chardbRef` markers to build the manifest at
first use, applies the policy overrides), constructs a Hono instance,
and routes through `mountChardb` so the reserved prefixes (`/q`,
`/ws`, `/f`, `/p`, `/s`, `/_chardb/`, and the optional `/api/auth/*`
better-auth mount) claim incoming requests before the user's routes
run. The `auth` slot accepts either a pre-built `ChardbAuth` (from
`defineAuth(...)`) or inline better-auth options (`{ plugins, appName,
… }`) — the inline form is for simpler apps that don't need `auth` as
a separate named export. (`refs:` remains accepted as a deprecated
alias for `api:`.) The return shape is a Hono instance augmented with
the six Durable Object classes as direct fields and a lazy `.schema`
getter — so the example Worker is 13 lines: `defineAuth(...)`,
`chardb(...)`, a `.get` route, `export default app`, and one
destructure for the DO re-exports. Manifest construction is lazy so
ESM cycles between `worker.ts` and `schema.ts` (caused by `schema.ts`
importing `auth` from `worker.ts`) don't trip TDZ; `.schema` is
exposed as a getter so the spread with the user's domain namespace
also defers past the same cycle. The lower-level primitives
(`defineAuth`, `defineChardb`, `mountChardb`) remain public exports
for advanced split-worker setups.

**`chardb/server` Tier-1 DX exports** (`src/server/cdb-tenant.ts`,
`src/server/cdb-table.ts`, `src/server/define.ts`):
- `api` — a default `ChardbApi<Record<string, unknown>>` factory so
  `api.ts` never starts with `const api = createApi<typeof auth &
  typeof domain>()`. Drizzle's `.from(table)` reads the row type from
  the table itself, so `ctx.db.select().from(messages)` typechecks
  without the bound schema generic. `createApi<T>()` stays exported
  for users who want Drizzle's RQB-typed `db.query.tableName.findMany
  ()` accessor.
- **`forOrg() / forUser() / globalScope()`** — the only sanctioned
  way to obtain a `cdbTable(name, columns, config)` builder. Each
  factory binds the schema file's tenancy axis once at the top:
  `const { cdbTable } = forOrg();` makes every table in the file
  org-tenanted, auto-discovers the tenant column from
  `.references(() => auth.organization.id)`, defaults `partitionBy`
  to that column, defaults the role lattice to `member.role`, and
  drives INSERT auto-fill from `ctx.auth.tenantId`. `forUser` does
  the user-FK equivalent (`self` is implicit; `selfBy:` is rejected).
  `globalScope` requires explicit `partitionBy:` per table.
  `cdbTable` is **not** exported from `chardb/server` directly — the
  ESLint rule `chardb/no-direct-cdb-table-import` flags any attempt.
- **`config` shape** — flat object. Verbs are intrinsic and fixed:
  row-level `read | create | update | delete`, column-level
  `read | create | update`. RLS lives in `roles:` (per-role verb
  grants, with column-granularity per verb) plus `publicRead:` plus
  the implicit tenant predicate. CLS lives EITHER inside `roles:`
  (each verb accepts `"*" | string[] | { exclude: string[] } | true |
  false`) OR in a sibling `columns:` block (per-column,
  per-verb role allowlists); both axes compile to one role × verb ×
  column matrix and contradictions throw `CDB_POLICY_CONFLICT` at
  boot. `self` is reserved as the row-creator role and requires
  explicit `selfBy: "<userFkColumn>"` in `forOrg`/`globalScope`
  files. `user:`-prefixed role names match `user.role` (admin plugin)
  regardless of the file's tenancy lattice.
- **Runtime helpers** — `compileCdbPolicies(table)` returns a
  `PolicyDefinition[]` for the existing pipeline
  (`applyPoliciesToWhere`, `applyRowPolicies`, `policyDigest`).
  `applyColumnMask({ rows, table, auth })` projects forbidden columns
  to `null`. `assertColumnsWritable({ values, table, verb, auth })`
  throws `CDB_FORBIDDEN_COLUMN` when the payload touches a column the
  caller's roles don't grant. `buildAccessControl(schema)` walks the
  schema's cdbTables and materializes a single better-auth
  `AccessControl` + `RolesMap` (org-scope) + `RolesMap` (user-scope)
  that the `chardb()` factory patches into the `organization()` /
  `admin()` plugin instances on first request.
- **Bundled plugins** — `defineAuth` automatically prepends
  `organization()` and `admin()` to the user's plugin list (skipped
  if the user supplied their own configured instance). Schema files
  reference `auth.organization` / `auth.member` / `auth.user` without
  the user re-declaring the plugin import, and cdbTable's role
  lattice plumbing is wired without per-app boilerplate.
`api.ts` uses the schema-bound `createApi<typeof auth & typeof domain>()`
factory: `TDb` is bound once, `TArgs` is inferred from each mutation's
`args: StandardSchemaV1` validator (zod / valibot / arktype / typebox /
drizzle-zod, anything that conforms to the `@standard-schema/spec`
contract), and `TResult` is inferred from the handler's return value.
`partitionKey: "organizationId"` is a string shorthand typechecked
against the args schema; `api.policy<typeof messages>("name", { … })`
infers `TRow` from `$inferSelect`. The result is zero per-mutation
type aliases in `api.ts` (no `PostMessageArgs`, no `MessageRow`, no
`Db`, no `defineMutation<Db, Args, Result>` explicit-generic triplet,
no `& { [k: string]: RawJson }` intersection). Args are validated at
the wire boundary so the handler never receives an ill-typed payload;
downstream consumers pull the wire shape out of the handler with
`Parameters<typeof postMessage>[1]` and `Awaited<ReturnType<typeof
listMessages>>[number]`.

**Schema-first RLS + CLS** (`src/server/cdb-tenant.ts`,
`src/server/cdb-table.ts`, `src/server/cdb-policy.ts`,
`src/server/cdb-cls.ts`, `src/server/cdb-access.ts`) — every row- and
column-level policy is declared inline on the cdbTable definition.
The schema author writes one `forOrg() / forUser() / globalScope()`
factory per file and one config object per table; chardb compiles to
the existing `PolicyDefinition[]` pipeline (no wire format change),
materializes a single better-auth `AccessControl` from every
table's `roles:`, patches the `organization()` / `admin()` plugin
instances at first request, and exposes `applyColumnMask` /
`assertColumnsWritable` for runtime CLS enforcement. The example's
21-line `api.ts` (with five separate `tenantScope` / `ownerScope` /
`requirePermission` exports referencing a `chatRoles` thunk in
`worker.ts`) collapsed to one `cdbTable(... { roles, selfBy })` call
per table; `chatRoles`, `defineRoles`, `roles.ts`, and the `import {
organization } from "better-auth/plugins/organization"` line all went
away. `test/server/cdb-table.test.ts` covers factory binding (org /
user / global), tenant-column auto-discovery, ambiguity / missing-FK
error codes, selfBy compile-required when `self` appears, role-axis
+ column-axis matrix compilation, contradiction detection,
`PolicyDefinition` shape parity, column mask + writability checks
(including the autoFilled-bypass), and AccessControl materialization
with `user:` prefix routing — 23 cases in total, all green.

**Just-makes-sense defaults** (`src/colocation/types.ts:DEFAULT_POLICY`,
`src/server/define.ts`, `src/server/entrypoint.ts`) — chardb ships
opinionated defaults so the example's `policy:` block is empty and
every mutation drops three lines of ceremony:

- `DEFAULT_POLICY.strictMultiRoot = false` — multi-root tables
  (`messages` / `audit_events` / custom-plugin `botToken`, every
  better-auth plugin table that FKs to both `organization` and `user`)
  auto-colocate via the first matching `distributionRoot` (`"organization"`).
  Strict mode is one-line opt-in via `policy: { strictMultiRoot: true }`
  when the user wants `CDB_AMBIGUOUS_COLOCATION` to surface as an error
  instead.
- `partitionKey` ⇒ implies `singlePartition: true` (extracting a key is
  meaningless when the mutation doesn't live in exactly one partition).
- `singlePartition: true` ⇒ implies `idempotencyTtl: "24h"` (every
  partition-owning mutation is retry-safe via the op-log dedup wrapper;
  24h matches what every SaaS app wants).
- Explicit values always win, so the user can pass `singlePartition:
  false` alongside a `partitionKey` to opt out of the implication.

Net effect on `example/chat/src/server/worker.ts`: the 17-line
`policy.overrides` block is gone, the manual Hono construction is
gone, `defineChardb` + `mountChardb` collapse into one `chardb({…})`
call, and the six DO classes ride out via one `export const { … } =
app` destructure. The whole Worker is 13 lines. Net effect on every
mutation: `singlePartition: true` and `idempotencyTtl: "24h"` are no
longer written. `test/server/define.test.ts` covers all four implication
edges (5 cases) and `test/colocation/derive.test.ts` covers the
default ⇒ first-root resolution + the opt-in strict behaviour. The 5 E2E test files exercise the pure layers under
realistic load (1k+ ops where it matters), with deterministic xorshift
seeds; `test/auth/synthesize.test.ts` covers the synthesizer, the typed
column accessors, the `defineAuth` one-shot, and the reserved-namespace
guard.

## Invariants enforced today

- xxhash64 seed=0 + 16,384 vshards (`vshard.ts`, pinned test vectors)
- `_chardb_op_log` `UNIQUE(principal_id, mut_id)` (`oplog/schema.ts`)
- `INSERT OR IGNORE`+`SELECT changes()` inside `transactionSync` (`oplog/wrapper.ts`)
- Wire envelope `protocolV: 1` + every error carries `{code, retryable, correlationId, docs}`
- Deterministic FK-chain colocation (`colocation/derive.ts`)
- chardb-supported better-auth profile (`auth/profile.ts`)
- DBAdapter wrapper dispatching epoch bumps from create/update/delete (`auth/adapter.ts`)
- Plugin partition-key overrides for apiKey/jwks/rateLimit/verification (`auth/plugin_partition_keys.ts`)
- VshardMap range monotonicity (`vshard.ts` — split-only, contiguity-asserted)
- Wrangler.jsonc shape enforced by `chardb doctor` (`cli/wrangler_template.ts`)
- `cf-chardb-correlation-id` propagation + `Server-Timing` on every entrypoint response
- PITR barrier ticks via `scheduled()` cron → `Catalog.openBarrier` + per-shard `barrierBookmark` ack
- Mutation routing: Gateway.onMut → CDB_WORKER.runMutation (manifest lookup + partitionKey extraction) → Catalog.route → Cdb.mutate
- User `defineCron` callbacks dispatched in `scheduled()` from the bundler manifest, matched by cron expression equality
- `_chardb_dt_state` / `_chardb_dt_participant` DDL shipped now (server/dt.ts) so v1.1 distributed-txn migrations don't churn
- Atomic vshard cutover via `Catalog.cutover` — single `transactionSync` over (range-table edit, schema-epoch bump, idempotency guard keyed by `migId`); mirrors `spec/Resharder.tla::CatalogCutover`
- `_chardb_split_state` per-shard table tracks tail-capture role, applied LSN, and drained flag for each in-flight migration
- Vite plugin export discovery via the TypeScript compiler API (with a regex fallback); aliased `import { defineMutation as dm }` is recognized
- Reshard tail capture via `AFTER INSERT/UPDATE/DELETE` triggers writing `json_object(...)` payloads into `_chardb_split_log`; identifier names whitelist-validated against `[A-Za-z_][A-Za-z0-9_]*`
- Resharder per-migration cursors persisted in `migration_state.bulk_cursor` / `tail_cursor` so a restart resumes mid-flight without double-applying rows
- `chardb deploy` plan digest is `sha256(stableJson({ jobs, tailConsumer }))` so CI can refuse a deploy when sensitive fields drift unexpectedly
- `policyDigest` sorts policies by name before hashing (order-independent) — keeps live-query cache invalidation stable when callers shuffle the policy array
- `defineMutation` / `defineQuery` preserve the user handler's `Function.name` on the wrapper so `attachRef`'s dev-path `autoRef` doesn't collapse all helpers to `mutation#fn`
- `runMutation` is implemented on a pure helper (`server/manifest.ts::routeMutation`) so the routing decision is testable without booting workerd; the `WorkerEntrypoint.runMutation` RPC is a one-liner over it
- `SubscribeArgs.intervals` is typed `WireInterval[]` (not `unknown[]`) — Gateway↔Cdb subscribe RPC no longer depends on `as never` to cross the boundary
- `decodeWire` validates against closed `UP_TAGS` / `DOWN_TAGS` whitelists exported from `src/wire.ts`; unknown tags throw `TypeError` referencing `protocolV=${PROTOCOL_V}`
- `checkProtocolV(advertised)` returns either `null` (matching) or a `mustRefetch:protocolMismatch` Down envelope — version negotiation lives in one helper rather than scattered through the entrypoint
- `ChardbRef` brand constructor enforces `<kind>#<name>` format at construction; the wire boundary can't accept arbitrary user data into a typed ref
- `_chardb_split_log` JSON columns (`before`, `after`) are typed `JsonText | null` and decoded only through `parseJsonColumn`, which throws on malformed JSON or non-object roots — trigger corruption fails loudly instead of silently re-applying garbage
- `Gateway.onHello` derives `principalId` from `decodeJwtClaims(msg.jwt).claims.sub`, falling back to a clientId-projection bucket key when the token is missing/expired/malformed; signature verification (the `catalog_jwks` SWR cache layer) is the next layer up — write paths re-validate authority before granting any

## Things deliberately not stubbed

If a function throws "requires the chardb server runtime", that's intentional — those are typed user-facing handles backed by RPC calls into the chardb DO classes at runtime, not no-ops to fill in.
