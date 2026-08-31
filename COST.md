# Cost model

Chardb does not add a hosted-service charge. A deployed application consumes the Cloudflare products bound in its Wrangler configuration. Better Auth traffic, application queries, realtime delivery, files, vectors, migrations, and range movement all contribute to those Cloudflare meters.

This document records Cloudflare's published Workers Paid rates as of 2026-08-30. Rates and included usage are account-wide and can change. Use the linked Cloudflare pages and the account's billable-usage dashboard for an invoice estimate.

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Durable Objects metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)

## Paid-plan units

Let `over(usage, included)` be `max(0, usage - included)`, and let `roundUnit(value, unit)` round a positive value up to the next whole billing unit. The Workers Paid plan has a $5 monthly account minimum.

| Meter | Included each month | Published overage rate |
| --- | ---: | ---: |
| Worker requests | 10 million | $0.30 per million |
| Worker CPU time | 30 million CPU-ms | $0.02 per million CPU-ms |
| Durable Object requests | 1 million | $0.15 per million |
| Durable Object duration | 400,000 GB-s | $12.50 per million GB-s |
| SQLite rows read in Durable Objects | 25 billion | $0.001 per million rows |
| SQLite rows written in Durable Objects | 50 million | $1.00 per million rows |
| SQLite data in Durable Objects | 5 GB-month | $0.20 per GB-month |
| R2 Standard storage | 10 GB-month | $0.015 per GB-month |
| R2 Standard Class A operations | 1 million | $4.50 per million |
| R2 Standard Class B operations | 10 million | $0.36 per million |
| Vectorize queried dimensions | 50 million | $0.01 per million |
| Vectorize stored dimensions | 10 million | $0.05 per 100 million |

The component formulas, before taxes and any account-specific terms, are:

```text
Worker request overage = over(worker requests, 10,000,000) / 1,000,000 * $0.30
Worker CPU overage     = over(CPU-ms, 30,000,000) / 1,000,000 * $0.02

DO request overage     = roundUnit(over(DO requests, 1,000,000), 1,000,000) / 1,000,000 * $0.15
DO duration overage    = roundUnit(over(GB-s, 400,000), 1,000,000) / 1,000,000 * $12.50
DO row-read overage    = over(rows read, 25,000,000,000) / 1,000,000 * $0.001
DO row-write overage   = over(rows written, 50,000,000) / 1,000,000 * $1.00
DO storage overage     = over(SQL GB-month, 5) * $0.20

R2 storage overage     = roundUnit(over(Standard GB-month, 10), 1) * $0.015
R2 Class A overage     = roundUnit(over(Class A operations, 1,000,000), 1,000,000) / 1,000,000 * $4.50
R2 Class B overage     = roundUnit(over(Class B operations, 10,000,000), 1,000,000) / 1,000,000 * $0.36

Vectorize query overage = over(queried dimensions, 50,000,000) / 1,000,000 * $0.01
Vectorize store overage = over(stored dimensions, 10,000,000) / 100,000,000 * $0.05
```

Cloudflare rounds Durable Object compute and R2 billable quantities to their published billing units. The pricing pages remain authoritative for rounding and account-specific inclusions. Workers, R2 Standard, and Vectorize do not charge for data transfer to the Internet.

## How Chardb reaches those meters

An inbound HTTP request or WebSocket upgrade counts as a Worker request. Worker subrequests do not add Worker request charges. Each Durable Object RPC method call is a Durable Object request, including calls among Catalog, Gateway, Cdb, and Resharder. Alarm invocations are Durable Object requests, and scheduling an alarm writes one SQLite row.

SQLite metering counts rows scanned or changed, not rows returned. Secondary indexes, Chardb's operation log, live-query state, file metadata, vector heads, delivery outboxes, migrations, and range movement add reads or writes. A domain mutation is therefore not equivalent to one billed row write. Inactive Durable Objects incur no duration charge, but their SQLite data remains billable until removed. Gateway uses Cloudflare's WebSocket Hibernation API, so an idle eligible connection does not keep duration running. Incoming Durable Object WebSocket messages use Cloudflare's 20-to-1 request billing ratio; outgoing messages are free.

The current file path maps to R2 operations as follows:

| Chardb file action | R2 operation |
| --- | --- |
| Fresh upload | One conditional `PutObject`, Class A |
| Retry after the object already exists | Another conditional `PutObject`, then `HeadObject`, Class B, to verify identity |
| Attach a file ID to a row | No R2 operation |
| Download | One `GetObject`, Class B, after authorization and row-policy checks |
| Delete or cleanup | `DeleteObject`, free under current R2 pricing; Durable Object and SQLite work still applies |

R2 storage is the average daily peak measured in GB-month. Bytes uploaded or downloaded do not establish storage cost without object lifetime.

Vector mutations commit the SQLite head and delivery intent before Vectorize delivery. Retries, replacement versions, deletion settlement, and temporarily retained physical vectors can make the physical stored-vector count differ from the number of logical rows. For a simple static index, Cloudflare publishes:

```text
queried dimensions = (query vectors + stored vectors) * dimensions
stored dimensions  = stored vectors * dimensions
```

Use Cloudflare's Vectorize counters for Chardb rather than substituting logical row counts.

## Evidence boundary

Current benchmark and proof reports identify the candidate, workload, runtime, scheduled operations, transferred bytes, latency, throughput, correctness, and cleanup. They do not record Worker CPU-ms, Durable Object requests, Durable Object GB-s, SQLite rows read or written, R2 GB-month, or Vectorize billing dimensions for the complete lifecycle.

Before citing a local-to-Cloudflare file benchmark, bind it to the exact package tarball and produce a compact receipt:

```sh
bun run bench:files:verify -- --tarball ./chardb-core-0.1.0.tgz --evidence ./benchmarks --output ./file-benchmark-verification.json
```

The verifier recomputes the tarball hash and size, checks every raw report and the paired comparison, and records that billing counters were not collected. It does not estimate a bill from latency or operation counts.

End-to-end latency cannot be converted into Worker CPU time or Durable Object GB-s. Durable Object duration is active wall time across objects and can include time awaiting I/O or time an object cannot hibernate. The billable values must come from Cloudflare analytics or the account's billable-usage data.

Chardb does not publish a total monthly-cost claim until a fixed deployed workload records those Cloudflare counters, includes background settlement and alarms, and separates ordinary traffic from migrations and range movement. Local and deployed latency comparisons remain performance evidence only.
