# Status

Chardb is an experimental organization-tenanted database for Cloudflare Workers. The preview target is one Better Auth-native path built on Durable Objects, Drizzle schema ownership, transactional mutations, live queries, R2 files, and Vectorize vectors.

Do not use it for production data. Backup, restore, replica promotion, failover, regional resilience, and long failure runs do not exist.

## Release contract

| Area | State | Contract and limit |
| --- | --- | --- |
| Better Auth organizations | Implemented | Better Auth owns sign-in, sessions, organizations, and membership. Chardb verifies JWTs at Gateway and refreshes membership through Catalog before data access. |
| Organization and organization-user tables | Implemented | `forOrg()` handles organization-wide rows. `forOrgUser()` adds verified user ownership inside the organization, with separate organization-role, user-role, and `self` checks. One operation reaches one physical Cdb transaction. User-only tenancy and global tables are not public. |
| Mutations | Implemented | Stable refs, bounded JSON, schema-epoch fencing, atomic domain and operation-log writes, and replay deduplication are enforced. |
| Queries and realtime | Implemented | Registered queries and bounded `env.DB` selects compile to one versioned plan and run through one Cdb executor. Durable live registrations rerun after matching writes, auth changes, schema activation, or source cutover. Unsupported SQL shapes fail closed. |
| Migrations | Initial and sequential additive authoring implemented | `chardb migrations generate --name <name>` inspects conventional auth and schema modules twice in fresh Bun processes. It verifies the complete static JSON digest chain, generated TypeScript, and journal before appending the next version. Additive versions accept new tables, nonunique indexes, and nullable unconstrained columns. They reject gaps, edited history, and changes that need data cleanup or a table rewrite. Execution resumes the same migration ID, verifies final schemas, and keeps public traffic closed until Catalog publishes the epoch. |
| Wrangler and Miniflare | Implemented | Generated projects use `wrangler.toml`, native Durable Object migrations and four explicit same-Worker namespace bindings, Wrangler, and Miniflare. `ctx.exports` is a fallback only where the runtime supplies it; generated Durable Object calls do not depend on that fallback. Doctor and preparation commands also accept `wrangler.jsonc`. |
| Organization files | Public experimental | Rows store opaque file IDs. The supported path covers upload, attach, policy-aware download, replacement, restart, organization deletion, bounded alarm cleanup, and exact R2 byte checks. Multipart upload, public URLs, composite row keys, bucket moves, backup, and restore are absent. |
| Organization vectors | Public experimental | `vector()`, transaction-bound set and delete operations, and `searchVector()` use organization routing and policy. SQLite is authoritative and Vectorize delivery is eventual. The exact-candidate proof harness verifies live invalidation, adversarial filtering, response-loss replay, exact causal-ID cleanup, paired local and deployed runs, and independent resource-absence checks. |
| Range movement | Experimental operator command | `chardb experimental shards` drives bounded checkpoints for rows, file metadata, and vector state. The exact-candidate combined harness exercises response loss, cutover, source drain, file identity, vector continuity, search, and cleanup. |
| Operations | Experimental only | [OPERATIONS.md](OPERATIONS.md) defines signals, containment, migration resume, and hard stops. |

The public package entries are `@chardb/core`, `@chardb/core/server`, `@chardb/core/react`, `@chardb/core/files`, and `@chardb/core/vite`. Internal Durable Object classes, RPC types, policy compilers, presence, streams, distributed transactions, and runtime configuration are not package exports.

## Evidence rules

Source tests and component proofs do not admit a release. The final preview must be packed once, then reused unchanged across all five evidence kinds:

1. `preview`, including generated-project, chat, browser, and packed public-vector browser reports;
2. `cloudflare-files`;
3. `cloudflare-file-reshard`, using the combined row, file, and vector workload;
4. `cloudflare-vectors`;
5. `os-ci`, containing checksummed Ubuntu x64, macOS arm64, and Windows x64 reports from one GitHub Actions run.

`bun run release:admit` recomputes the tarball digest and byte count, validates the exact report schemas and checksum manifests, rejects symlinks and overlapping evidence directories, and requires verified Cloudflare cleanup. A report from another tarball cannot fill a missing gate.

No moving source tree is an admitted release. Freeze one package only after code and package documentation stop changing, then run every gate against those exact bytes.

## Release blockers

- Candidate `292fa3a4` passes the standalone exact-package, deployed R2, deployed combined movement, and deployed Vectorize gates. It is not admitted because the intended source tree is still uncommitted and therefore cannot produce the clean preview and bound GitHub evidence.
- Run the clean preview gate and `bun run release:admit` against the exact package produced from the committed candidate.
- Pass the exact candidate on the bound Ubuntu x64, macOS arm64, and Windows x64 GitHub jobs.
- Keep the production warning until backup, restore, failover, and longer failure tests exist.

Current candidate evidence is under [`artifacts/candidate-292fa3a4`](artifacts/candidate-292fa3a4). Its package SHA-256 is `292fa3a49f3aa56730f7a07938c2238bb1974bd64bb4e1436c3f0c3a3a08e087` and its packed size is 454,332 bytes. The deployed proof resources were deleted and independently confirmed absent. This evidence remains evaluation evidence until the clean preview, cross-OS bundle, and final admission pass.

## Benchmark interpretation

Benchmark reports are descriptive. They must name the candidate, runtime, workload, sample count, warmup policy, timings, and correctness flags. Comparators reject different candidate or workload identities. Local fake services isolate Chardb execution time; paired Cloudflare runs include service and network time. They do not measure a Cloudflare bill. A short run does not define an SLA.

[COST.md](COST.md) records the current Cloudflare units and the Chardb operation mapping. A total cost remains unmeasured until a fixed deployed workload records Cloudflare's billable counters, including background alarms and settlement.

[PLAN.md](PLAN.md) is the executable release checklist. Work outside the preview belongs in [NEXT_SCOPE.md](NEXT_SCOPE.md).
