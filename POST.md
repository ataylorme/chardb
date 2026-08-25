# Publication copy

## Concise social post

I am publishing chardb to find out whether its core model is worth finishing. Declare an organization boundary in a Drizzle schema, then derive colocation, routing, authorization, and shard-local transactions from it.

A narrow read/write slice now works under workerd. Mutations cross verified JWT subject, Catalog membership and roles, tenant routing, Cdb policy enforcement, and an atomic SQLite write with its idempotency log.

An explicit organization query takes a stable ref, `authority: "organization"`, a partition key, and a developer-written intent callback that runs on the server. Cdb records the `cdbTable` dependencies used by the supported query shape and checks them against the declared table intent. Gateway installs a durable generation before Cdb subscribes. A commit writes matching invalidations to a durable outbox, Gateway reruns the query with current Catalog authority, and clients receive and acknowledge replacement snapshots.

Gateway and Cdb now include a static digest of the declared tables' row and column policy metadata in registered-query identity. The digest does not hash arbitrary function source. Policy drift retires the generation before a rerun or staged snapshot send. A quiet registration detects drift on its next work trigger.

A real workerd test covers two clients in one organization, an isolated empty result for another organization, outbox drain, acknowledgements, and reconnect with a fresh subscription. It also evicts Gateway and Cdb while a hibernated socket has a staged replacement, then delivers and acknowledges that stored snapshot after both objects restart. Another test keeps a socket open through membership downgrade, restoration, and deletion. Dirty reruns return an empty snapshot for the downgraded role, restore rows when the role returns, and retire the registration after deletion. A configured Catalog test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority. A separate clean-tarball smoke installs version 0.1.0. It proves Better Auth HTTP sign-in, same-`mutId` replay, and rejection of a second principal's attempt to query another organization's rows.

Subjectless Gateway queries stay closed. Better Auth anonymous accounts are authenticated principals after JWT issuance and organization membership. `publicRead` removes the table-role requirement for selects, but not JWT verification, membership, the tenant floor, write grants, or cross-organization isolation. A four-case workerd test proves those boundaries.

The browser client now gives each mutation a 60-second deadline by default. A reconnect resends the same pending `mutId` without resetting that deadline. Timeout returns nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because the server may already have committed the request. The client has no public retry handle or automatic retry policy.

This is still a prototype. The packed smoke now applies its packaged schema and survives a persistent Worker and Durable Object restart. Separate configured tests cover outbound JWKS rotation and a forward Catalog and Cdb upgrade with exact epoch fencing, replay, baseline adoption, and reconstruction. Exact resume replay, down migrations, online traffic during migration, and cleanup after repeated storage failure remain open. I would not use it for production data.

Does schema-declared organization tenancy solve a real problem, or just move complexity around?

[Read the code and current status](https://github.com/zpg6/chardb)

## Hacker News or Reddit post

### I built a prototype around schema-declared organization tenancy. Is the model worth finishing?

I am publishing chardb, an experimental tenant-sharded SQLite design for Cloudflare Durable Objects.

The idea is to make the organization boundary part of the Drizzle schema. A table declared with `forOrg()` carries the placement and policy boundary. From that declaration, chardb can derive colocation, virtual-shard routing, row and column rules, and the shard-local transaction boundary.

One narrow path now works in a focused workerd harness. A public mutation must declare `authority: "organization"` and an explicit stable ref. Gateway verifies the JWT and retains only its subject. It validates the mutation arguments, extracts the organization key, and asks Catalog for current membership, roles, and auth epochs. Catalog routes the organization to a Cdb Durable Object. Cdb applies the schema policy and commits the SQLite write with its idempotency record in one synchronous transaction.

The same public boundary now supports one narrow live query path. The query declares `authority: "organization"`, an explicit stable ref, a partition key, and a developer-written intent callback that runs on the server. Gateway validates the arguments before Catalog checks current organization membership. The intent must resolve to the same organization and exactly one shard. Cdb conservatively records `cdbTable` dependencies for supported full-row queries and rejects a result if any recorded table is missing from `intent.tables`.

Gateway and Cdb also derive a static digest from the declared tables' row and column policy metadata. Query identity includes that digest, but not arbitrary function source. Gateway checks it before a dirty rerun and before sending a staged snapshot. Cdb checks it before registered execution. Bootstrap retires older registrations that lack the digest. A quiet registration detects policy drift when work next reaches it.

Gateway persists a unique generation before calling `Cdb.subscribe`. Cdb records matching write invalidations in a durable outbox inside the same transaction as domain SQL and the operation log. Gateway reruns dirty registrations, stages immutable snapshots, retries delivery, and advances delivery only when the client acknowledges the exact cookie. A same-cookie retry gets another acknowledgement without applying the rows twice.

A focused workerd test connects two org-A clients and one org-B client. All three receive and acknowledge initial snapshots. A public mutation then produces replacement snapshots for org A, while org B reruns to an empty result under policy. The clients acknowledge those snapshots, the Cdb outbox drains, and a reconnect with a fresh subscription reads current state. The test also evicts Gateway and Cdb with a hibernated socket and a staged replacement, reconstructs both objects, and delivers the same snapshot cookie. A separate long-lived socket stays connected while its membership changes from `member` to `viewer`, back to `member`, then to deleted. Dirty reruns re-read Catalog authority and reflect each transition.

The anonymous contract is narrower than the name suggests. Gateway rejects queries without a valid JWT. Better Auth anonymous sign-in produces an authenticated account and JWT; Catalog must still find organization membership. On a `publicRead` table, that principal can select without a matching table role, but the tenant floor still applies. The workerd proof covers the allowed own-organization read and three denials: cross-organization, missing JWT, and invalid JWT. `publicRead` never grants writes.

The focused tests cross a configured WebSocket, Gateway, Catalog, and Cdb with test-seeded auth. A configured Catalog workerd test separately creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. A separate smoke script installs chardb 0.1.0 from a clean tarball and builds the chat client with both stable refs. Its first principal signs in through Better Auth HTTP, acknowledges an empty initial snapshot, posts a message, acknowledges the live replacement, replays the same mutation id, and reads exactly one row through a second subscription. A second principal moves to another organization. Gateway rejects its query against `demo-org` and returns an empty result for its own organization.

The client option `mutationTimeoutMs` defaults to 60 seconds. A reconnect resends a pending mutation with its original `mutId` and original deadline. Timeout returns nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because the request may already be committed. Send failure, close, session failure, and a terminal server result clear the timer. React forwards the option, but the public API has no retry handle or automatic retry policy.

That packed smoke applies the example's journal through the packed CLI, then restarts Miniflare over persistent Durable Object storage and reconstructs both Better Auth sessions before replay and isolation checks. Separate configured tests cover outbound JWKS rotation and a forward Catalog and Cdb schema upgrade with retained data, stale and future epoch rejection, exact mutation replay, baseline adoption, and restart. They do not prove exact resume replay, down migrations, or application traffic during migration. Gateway commits registration retirement and its cleanup alarm together. If that storage transaction fails, the retirement rolls back and the head stays active. A returning client supersedes it, but a quiet abandoned registration can remain. Live dependency checks cover tracked full-row queries only. Raw or untracked predicates, embedded subqueries, and `orderBy` callbacks fail closed, while projections, joins, richer query shapes, and interval verification remain unfinished. Automated resharding also remains unfinished. This is source for review, not something to run against production data.

I am less interested in presenting a finished database than in testing the premise. Does putting organization tenancy in the schema remove enough repeated routing and authorization code to justify the machinery? Or does it hide decisions that applications should keep explicit?

[Code, status, architecture, and implementation plan](https://github.com/zpg6/chardb)

## Feedback questions

1. Would you trust the schema declaration as the source of organization placement and policy, or would you want those decisions explicit in every handler?
2. Is the mutation trust boundary sound when Gateway keeps only the verified JWT subject and re-derives membership and roles from Catalog?
3. Is requiring both `authority: "organization"` and an explicit stable ref useful friction, or awkward API design?
4. Is full-snapshot replacement a useful first live-query model, or would your workload require incremental patches immediately?
5. What migration and resume guarantees would you require before testing this with non-production application data?
