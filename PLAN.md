# Release standard

The product is the generated application: Better Auth organizations, a Drizzle schema, live queries, R2 files, Vectorize search, Wrangler deployment, and Miniflare tests.

Every release is built once and tested as the artifact users install:

- Typecheck, lint, unit tests, real Workerd tests, and documentation checks must pass.
- The generated app, chat example, and browser tests must install the same packed `@chardb/core` tarball.
- Linux, macOS, and Windows must pass against that package.
- File, vector, and range-movement proofs must run on disposable Cloudflare resources and prove their cleanup.
- npm and crates.io contents must be reviewed before publishing.
- Public landing and example URLs must be tested after deployment.

CI is the live release record. [STATUS.md](STATUS.md) describes the supported product; [PREVIEW.md](PREVIEW.md) documents the evidence procedure.

## Boundaries

Backup and restore, regional failover, automatic resharding, presence, streams, and distributed transactions remain out of scope. See [NEXT_SCOPE.md](NEXT_SCOPE.md) for the order in which those should be considered.
