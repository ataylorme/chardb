# Docs verification

The guide is contracted to this exact final packed artifact:

- package: `@chardb/core@0.1.0`
- file used for verification: `/private/tmp/chardb-candidate-sweep.JblNYO/chardb-core-0.1.0.tgz`
- size: `454690` bytes
- SHA-256: `73dd07bfa9f38a321ea612930563ce88b86266730a38fe114fd1059ecad100d2`

`chardb init my-chardb-app` creates the named directory. The docs contract runs that packed command in a clean temporary directory, compares the embedded generated examples byte for byte, and exercises additive migration generation. Set `CHARDB_DOCS_TARBALL` to the packed artifact before running the contract.

## Public API boundaries

The guide documents the shipped API, including its explicit steps:

- Queries and mutations carry stable `ref` values. Organization operations carry `organizationId`; mutations also declare `authority` and `partitionKey`.
- Browser files use `fileRef(table, column)`. Upload and row attachment are separate operations, and rows store an opaque file ID.
- Applications supply vector values to `ctx.vector.set()` and `searchVector()`. Chardb does not select or call an embedding model.
- Vectorize setup requires a Wrangler binding, index creation, and `chardb vectorize prepare`. `setup:cloudflare` creates or verifies only the generated R2 bucket.

## Release limits

The artifact has no supported backup, export, restore, point-in-time recovery, replica promotion, regional failover, or SLA. Range movement is an operator-driven experimental command, not automatic balancing or a recovery mechanism.
