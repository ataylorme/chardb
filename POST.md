# Publication copy

## Concise social post

I am publishing chardb to find out whether its core model is worth finishing. Declare an organization boundary in a Drizzle schema, then derive colocation, routing, authorization, and shard-local transactions from it.

A narrow read/write slice now works under workerd. Mutations cross verified JWT subject, Catalog membership and roles, tenant routing, Cdb policy enforcement, and an atomic SQLite write with its idempotency log.

An explicit organization query now takes a stable ref, partition key, and server-owned intent. Catalog authorizes it, routes exactly one organization partition to one Cdb read, and returns one protocol-v3 snapshot. Empty results arrive as an empty array.

This is still a prototype. The snapshot creates no server registration. Live invalidation, replacement delivery, replay, versioned migrations, and a packed-app sign-in-to-read/write flow are unfinished. I would not use it for production data.

Does schema-declared organization tenancy solve a real problem, or just move complexity around?

[Read the code and current status](https://github.com/zpg6/chardb)

## Hacker News or Reddit post

### I built a prototype around schema-declared organization tenancy. Is the model worth finishing?

I am publishing chardb, an experimental tenant-sharded SQLite design for Cloudflare Durable Objects.

The idea is to make the organization boundary part of the Drizzle schema. A table declared with `forOrg()` carries the placement and policy boundary. From that declaration, chardb can derive colocation, virtual-shard routing, row and column rules, and the shard-local transaction boundary.

One narrow path now works in a focused workerd harness. A public mutation must declare `authority: "organization"` and an explicit stable ref. Gateway verifies the JWT and retains only its subject. It validates the mutation arguments, extracts the organization key, and asks Catalog for current membership, roles, and auth epochs. Catalog routes the organization to a Cdb Durable Object. Cdb applies the schema policy and commits the SQLite write with its idempotency record in one synchronous transaction.

The same harness now exercises one public query path. The query declares `authority: "organization"`, an explicit stable ref, a partition key, and server-owned intent. Gateway validates the arguments before Catalog checks current organization membership. The intent must resolve to the same organization and exactly one shard. One Cdb applies select policy and returns one protocol-v3 snapshot, including an empty array when nothing matches.

These tests cross a configured WebSocket, Gateway, Catalog, and Cdb, but they use test-seeded auth. They are not a complete application proof.

The query is deliberately one-shot. It creates no server registration and has no live invalidation, replacement delivery, or missed-change replay. Versioned domain migrations and a packed application test that starts with Better Auth sign-in and independently reads back a persisted write are also unfinished. Automated resharding is only tested as separate helpers and state machines. This is source for review, not something to run against production data.

I am less interested in presenting a finished database than in testing the premise. Does putting organization tenancy in the schema remove enough repeated routing and authorization code to justify the machinery? Or does it hide decisions that applications should keep explicit?

[Code, status, architecture, and implementation plan](https://github.com/zpg6/chardb)

## Feedback questions

1. Would you trust the schema declaration as the source of organization placement and policy, or would you want those decisions explicit in every handler?
2. Is the mutation trust boundary sound when Gateway keeps only the verified JWT subject and re-derives membership and roles from Catalog?
3. Is requiring both `authority: "organization"` and an explicit stable ref useful friction, or awkward API design?
4. What would turn the one-shot snapshot into credible server registration and live invalidation?
5. What migration and recovery guarantees would you require before testing this with non-production application data?
