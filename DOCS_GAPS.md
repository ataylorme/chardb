# Docs integration note

This docs scaffold targets the sealed `@chardb/core@0.1.0` preview artifact:

- file: `artifacts/release-final6/preview/chardb-core-0.1.0.tgz`
- SHA-256: `5da0a1ba1dfbabe06ecd0f6a6b7010e967fd82b791c312f926ba62da53faa338`
- package bin: `chardb`

The candidate's packaged README says `chardb init` creates the named project directory. The sealed binary instead writes the generated project into the current empty directory and uses `<name>` for the app, Worker, and bucket names. The public quickstart therefore creates and enters the directory before running `init`.

The exact tarball passed its clean generated-project proof on 2026-08-30. That run covered pinned install, initial and additive migration generation, typecheck, Cloudflare Vitest, Vite build, Wrangler dry-run, `chardb doctor`, local `dev`, Better Auth organization provisioning, authenticated HTTP and WebSocket traffic, live replacement, Worker restart, migration interruption and resume, and persisted reads after restart.

Integrators should either keep the explicit `mkdir` and `cd` sequence in the docs or change `init` in the release candidate, rebuild the tarball, and rerun the same proof. Do not merge the older `tasks-worker` examples; they predate the sealed generator.
