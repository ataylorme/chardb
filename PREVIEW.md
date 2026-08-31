# Preview release procedure

This procedure moves one exact Chardb tarball through local proof, CI evidence, and a bounded Cloudflare staging deployment. It does not make a production-readiness claim.

## Produce the release evidence

From a clean checkout of the candidate commit:

```sh
bun install --frozen-lockfile
bun run preview:gate -- --output-dir artifacts/preview --platform-name local-darwin-arm64
```

The output directory must be empty. Use a new directory for every run so stale reports or staging files cannot be mistaken for current evidence.

The command builds one npm tarball and uses that same file for the public-package, generated-project, chat, packed public-vector browser, and full browser proofs. It writes:

- `artifacts/preview/preview-gate.json`, the versioned step ledger;
- `artifacts/preview/generated-project.json`, the generated app's initial-install and authenticated version-two upgrade facts;
- `artifacts/preview/packed-chat.json`, containing native Better Auth membership, two-principal live delivery, replay, benchmark, restart, leave, denial, and retained-owner-access evidence;
- `artifacts/preview/packed-public-vector.json`, containing the packaged SDK's browser-visible pending, ready, refetch, and live vector-query transitions;
- `artifacts/preview/browser-proof.json`, containing native Better Auth, organization isolation, live update, reload, restart, R2 file lifecycle, organization deletion fencing, and active-organization range-movement evidence;
- `artifacts/preview/chardb-core-0.1.0.tgz`, identified by SHA-256 and byte count in every tarball-bound report;
- `artifacts/preview/staging-app`, a deployable copy of the visible organization chat whose `chardb` dependency points at that tarball.

A dirty worktree fails immediately and cannot produce a passing release report. A failed step leaves `preview-gate.json` with `summary.passed: false` and the exact failed step. The gate rejects generated-app, packed-chat, packed public-vector, or browser evidence whose package fingerprint differs from the tarball. The packed public-vector check installs the candidate package, typechecks Better Auth organization vector usage, rejects server imports in the browser bundle, and exercises pending, ready, refetching, and live replacement states.

For the initial install, the generated-project proof requires shard activation, Catalog still in `migrating`, public auth denial on both sides of a Wrangler restart, and same-ID resume. It then requires authenticated version-one mutations, a direct read, and a live replacement. For the version-two upgrade, it requires the frozen `src/migrations/v1.ts` to remain unchanged, the new Worker to fence authenticated reads and writes before migration and during the half-applied upgrade, the fence to survive restart, and the same upgrade ID to resume. Finally, it requires the old rows to survive, a post-upgrade mutation to reach the live query, and all rows to remain after a final restart. Do not deploy a tarball without a passing report.

The serialized Workerd migration harness supplies a separate correctness proof for activation-only live wake. It registers an idle live query, activates the schema without a domain write, loses the first Gateway response, reconstructs cold, and requires the exact invalidation change sequence to drain before any later write. That proof is not part of the generated-project browser report and does not replace the deployed Cloudflare gates.

Migration generation has its own fail-closed boundary. `chardb migrations generate --name <name>` reads conventional `src/auth.ts` and `src/schema.ts` in two sequential fresh Bun processes and requires byte-identical canonical snapshots. The first run writes version one with exclusive-create semantics. Every later run verifies each contiguous immutable JSON snapshot, its digest link, its generated TypeScript, and the exact journal. It then appends one additive version with a compare-and-swap journal update. Additive versions accept only new tables, nonunique indexes, and nullable unconstrained columns. Gaps, edited history, and changes that require data cleanup or a table rewrite fail before any artifact is published.

The GitHub workflow `.github/workflows/preview-gate.yml` runs the same command on Ubuntu 24.04 and uploads the entire evidence directory. Keep platform thresholds unset until repeated CI runs establish variance.

## Prepare the Cloudflare target

Choose a staging-only Worker name and Cloudflare account. Do not reuse a production Durable Object namespace or rename an existing Durable Object class.

Download the CI artifact and enter its `staging-app` directory. Install from the artifact-local tarball and validate the deploy bundle:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run deploy:dry
npx @chardb/core doctor wrangler
```

Doctor must accept exactly one mapping for each internal namespace: `CDB_CATALOG` to `Catalog`, `CDB_SHARD` to `Cdb`, `CDB_GATEWAY` to `Gateway`, and `CDB_RESHARD` to `Resharder`. These explicit bindings carry Durable Object calls in generated deployments. Do not rely on a `ctx.exports` fallback inside Durable Objects.

Configure the two secrets against this exact staging Worker:

```sh
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put CDB_ADMIN_TOKEN
```

Use independently generated values. Record the Worker name and Cloudflare account outside the repository. Never place either value in `wrangler.toml`, `.dev.vars`, a CI artifact, command history, or the preview evidence JSON.

## Deploy and migrate

The preferred disposable-staging path is the resumable promotion runner:

```sh
bun run preview:cloudflare -- \
  --gate artifacts/preview \
  --worker '<staging-worker-name>' \
  --url 'https://<staging-worker-host>' \
  --output artifacts/cloudflare-promotion \
  --private-dir '<private-directory-outside-artifacts>' \
  --migration-prefix '<stable-release-id>' \
  --benchmark-samples 3
```

The private directory is mode-restricted and contains generated staging secrets, installed dependencies, Miniflare state, and the authenticated proof session. It must stay outside the evidence directory. To upgrade an existing staging Worker without invalidating Better Auth sessions, add `--secrets-file <existing-env-file>` and `--admin-token-file <matching-token-file>` together. The runner never copies either value into evidence.

For a new Worker, Wrangler requires one ordinary deployment to apply Durable Object class migrations. Later stages use immutable version uploads followed by an explicit 100% traffic deployment. The runner activates version one, seeds Better Auth and organization data, deploys version two, stops after one shard, redeploys identical version-two input, resumes the same migration ID, deploys obsolete version-one code to prove fail-closed behavior, restores version two, and waits for both HTTP and Catalog readiness. It then runs matching Cloudflare and local Wrangler/Miniflare benchmarks, verifies comparable workload identity, scans every evidence file for both secrets, and writes `evidence.sha256`. A retry skips passed stages and retries only the failed stage. It never deletes the Worker.

The manual sequence below remains useful for diagnosis and for understanding each operator action.

Deploy the prepared application, record the version identifier printed by Wrangler, and then run the packaged migration CLI against the resulting HTTPS URL:

```sh
npm run deploy
CHARDB_ADMIN_TOKEN='<staging token>' npx @chardb/core migrate \
  --url 'https://<staging-worker-host>' \
  --id 'preview-v1-<unique-release-id>' \
  --target 1 \
  --concurrency 2
```

Use the same migration ID and target if the command is interrupted. Do not invent a replacement migration ID. Application traffic stays closed while the Catalog state is `migrating`.

## Dogfood proof

Open the deployed URL in a clean browser profile. The visible application must anonymously sign in through Better Auth, create two organizations, switch between them, and keep each message list isolated. Post a message in the first organization and receive the replacement without a reload.

Then:

1. reload the page and confirm the active organization and its message remain;
2. deploy the same artifact again without changing Durable Object classes or migration tags;
3. reload and confirm the row remains;
4. switch to the second organization, confirm the first organization's rows are absent, post a second message, and confirm live delivery;
5. record the CI artifact name, tarball SHA-256, Wrangler version identifier, migration ID, URL, UTC times, and outcome outside Chardb.

Stop immediately on a binding change, journal mismatch, stale-epoch loop, missing row, or migration state that cannot resume with the original ID. Follow `OPERATIONS.md`; Chardb still has no backup, restore, replica promotion, or region failover.

## Admit one candidate

Local preview, deployed files, deployed combined row, file, and vector movement, and deployed vectors remain separate evidence directories. Admit them only when they all identify the same tarball:

The combined row, file, and vector movement proof now has one entry point. It prepares an isolated app from the supplied tarball, runs the packed browser proof, starts a native local Wrangler target, creates one digest-owned Worker, R2 bucket, and Vectorize index, runs the paired workload, and then deletes the three Cloudflare resources. Both directories must be new, and the private directory must stay outside the evidence tree:

```sh
bun run proof:cloudflare:reshard -- \
  --tarball artifacts/preview/chardb-core-0.1.0.tgz \
  --output artifacts/cloudflare-file-reshard \
  --private-dir '<private-directory-outside-artifacts>' \
  --workers-dev-subdomain '<account-subdomain>' \
  --account-id '<32-character-hex-account-id>' \
  --confirm-disposable-resources
```

Wrangler uses its stored OAuth session by default. `--cloudflare-api-token-file <file>` supplies a private token file instead. The command writes the validated public preparation record to `preparation.json` and includes it in `evidence.sha256`. It will not write a passing teardown unless the browser proof, local and deployed samples, idempotent workload cleanup, secret scan, and independent Worker, bucket, and index absence checks all pass. A failed phase still runs owned cleanup and writes `orchestration.json`, but it omits the passing teardown and supplemental checksum manifest.

After the combined proof and the other deployed proofs pass, run admission:

```sh
bun run release:admit -- \
  --profile preview-v1 \
  --evidence preview=artifacts/preview \
  --evidence cloudflare-files=artifacts/cloudflare-files \
  --evidence cloudflare-file-reshard=artifacts/cloudflare-file-reshard \
  --evidence cloudflare-vectors=artifacts/cloudflare-vectors \
  --evidence os-ci='<downloaded-os-ci-directory>' \
  --output artifacts/release-admission.json
```

Admission recomputes the tarball identity, validates every required report and checksum manifest, rejects overlapping evidence directories and symlinks, and requires verified Cloudflare cleanup. The preview input must contain the packed public-vector report. The file-reshard input must contain the validated preparation record and use the combined row, file, and vector report schema. The OS input must contain canonical Ubuntu x64, macOS arm64, and Windows x64 reports from one GitHub Actions run. A previous candidate's reports cannot admit a new tarball. This procedure is not complete until the combined movement, expanded vector Cloudflare, and cross-OS reports pass against the same tarball.

Download the `os-ci-<commit>-<run-attempt>` artifact after the `CI` workflow passes. Admission requires that bundle; it cannot be omitted. The Windows report includes the packed generated app, Cloudflare Vitest, build, doctor, occupied-port cleanup, three forced parent terminations, descendant cleanup, port reuse, Better Auth restart, and organization-data persistence checks. Do not substitute a local report. The checksum catches changed bytes, but it is not a GitHub signature.
