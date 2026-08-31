# Docs DX audit

The guide is contracted to this exact preview artifact:

- package: `@chardb/core@0.1.0`
- file used for verification: `/private/tmp/chardb-candidate5.X9tXXI/chardb-core-0.1.0.tgz`
- size: `455344` bytes
- SHA-256: `4ec16920f255cd9eaefdb41cac004d9320d81e4c23e2f92e73a12cc680691ae4`

`chardb init my-chardb-app` creates the named directory. The docs contract runs that packed command in a clean temporary directory, compares the embedded generated examples byte for byte, and exercises additive migration generation. Set `CHARDB_DOCS_TARBALL` to the candidate tarball before running the contract.

## Product work still visible in the guide

These are product gaps, not prose problems. The public docs keep the current API explicit until each change ships.

### Derive mutation and query identity

Generated handlers repeat `ref`, `authority`, `partitionKey`, and `organizationId`. The Vite transform already knows the source export, and Better Auth already knows the active organization. A better public builder would derive the stable ref and organization route while still verifying current membership on the server. The caller should not be able to choose authority.

### Give files a browser-safe typed handle

The generated app names the table and column in a string locator, uploads a file, and then attaches the opaque ID in a separate mutation. The browser build should emit a typed file handle from `messages.attachment`; an attach helper should make the two-step lifecycle and abandoned-upload cleanup explicit.

### Make embeddings a declared resource

Applications currently produce raw number arrays, call `ctx.vector.set()`, and pass values into `searchVector()`. A typed embedding resource should declare the model once, embed writes after commit through the durable outbox, and accept text at search time. It must retain explicit escape hatches for externally generated vectors and model migrations.

### Provision declared Vectorize resources

`setup:cloudflare` creates the R2 bucket, but vector users still add TOML, create the index, and run `vectorize prepare` themselves. The setup script should discover declared vector resources and create or verify the binding, dimensions, metric, and metadata indexes in one idempotent command.

### Keep recovery claims closed

The artifact has no supported backup, export, restore, point-in-time recovery, replica promotion, regional failover, or SLA. Range movement is an operator-driven experimental command, not automatic balancing or a recovery mechanism.
