# Chardb Rust client

`chardb-client` is the native Rust client for Chardb protocol version 3. It
supports Windows, macOS, and Linux. Blocking and async callers use one session
worker, so reconnects, deadlines, subscription state, and mutation replay have
the same behavior in both APIs.

Chardb itself is still experimental. The client is designed for release, but
it does not change the database's current backup, restore, failover, or regional
resilience status.

## Install

The default build includes the blocking client, the runtime-neutral async
client, and Rustls with Mozilla `WebPKI` roots.

```toml
[dependencies]
chardb-client = "0.1"
```

Available features:

- `sync` exports `Client` and `Subscription`.
- `async` exports `AsyncClient` and `AsyncSubscription`. It does not require
  Tokio or another executor.
- `introspection` adds JSON Schema 2020-12 descriptions for application
  argument, mutation-result, and subscription-row types through `schemars`.
- `rustls-webpki-roots` uses the bundled public root set and is the default.
- `rustls-native-roots` reads the operating system root store. Use it for
  enterprise or private roots installed on the machine.
- `client` is the shared transport engine. Protocol-only consumers can disable
  default features and use `chardb_client::wire` without networking code.

The crate's minimum supported Rust version is 1.85.

For an application-managed private CA, pinned verifier, or client certificate,
build a `rustls::ClientConfig`, wrap it in `Arc`, and pass it through
`ClientConfig::tls_config`. JWTs are never put in HTTP headers or URLs.

One logical client owns one network thread and one WebSocket. Clones are cheap
`Arc` handles. The socket uses `TCP_NODELAY`, command and event queues are
bounded where growth would follow user traffic, and JSON limit checks count
serialized bytes without allocating a second copy of the data.

### Optional type introspection

Typed Serde results are always available. Enable `introspection` when a tool,
plugin host, dynamic UI, or schema registry also needs to inspect those types at
runtime.

```rust
# #[cfg(feature = "introspection")]
# fn introspection_example() -> Result<(), Box<dyn std::error::Error>> {
use chardb_client::introspection::{operation_schema, JsonSchema};

#[derive(JsonSchema)]
struct ListArgs {
    organization_id: String,
}

#[derive(JsonSchema)]
struct Message {
    id: String,
    body: String,
}

let contract = operation_schema::<ListArgs, Message>("src/queries.rs#list_messages")?;
let json = serde_json::to_value(contract)?;
# let _ = json;
# Ok(())
# }
```

This is application type metadata. Chardb still validates authorization,
routing, and the registered server handle independently.

## Blocking client

The endpoint is the Worker's WebSocket path without a `clientId` query
parameter. The client generates one stable ID, adds it to the URL, and repeats
the same ID in `hello`.

```rust,no_run
use std::time::Duration;
use chardb_client::{Client, ClientConfig, SubscriptionEvent};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ListArgs<'a> {
    #[serde(rename = "organizationId")]
    organization_id: &'a str,
}

#[derive(Deserialize)]
struct Message {
    id: String,
    body: String,
}

#[derive(Deserialize)]
struct Posted {
    id: String,
}

# fn get_jwt() -> Result<String, String> { unimplemented!() }
# fn main() -> Result<(), Box<dyn std::error::Error>> {
let client = Client::connect(
    ClientConfig::new("wss://example.com/ws", get_jwt)
        .connect_timeout(Duration::from_secs(10))
        .mutation_timeout(Duration::from_secs(60)),
)?;

let args = ListArgs { organization_id: "org-1" };
let mut messages = client.subscribe::<_, Message>("src/queries.ts#listMessages", &args)?;

match messages.recv()? {
    SubscriptionEvent::Snapshot { rows } => println!("{} rows", rows.len()),
    SubscriptionEvent::Error(error) => return Err(error.into()),
    _ => {}
}

let posted: Posted = client.mutate("src/api.ts#postMessage", &args)?;
println!("posted {}", posted.id);
client.close();
# Ok(())
# }
```

`Client::connect` waits for the authenticated `welcome`, not merely the HTTP
upgrade. No protected operation crosses the socket before that message.

## Async client

The async API uses the same methods and event types. Its futures use channel
wakers and work with any executor.

```rust,no_run
use chardb_client::{AsyncClient, ClientConfig, SubscriptionEvent};
use serde_json::json;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let client = AsyncClient::connect(ClientConfig::with_token(
    "wss://example.com/ws",
    "signed-jwt",
)).await?;

let mut rows = client.subscribe::<_, serde_json::Value>(
    "src/queries.ts#listMessages",
    &json!({ "organizationId": "org-1" }),
)?;

if let SubscriptionEvent::Snapshot { rows } = rows.recv().await? {
    println!("{} rows", rows.len());
}

let result: serde_json::Value = client.mutate(
    "src/api.ts#postMessage",
    &json!({ "organizationId": "org-1", "body": "hello" }),
).await?;
# let _ = result;
# Ok(())
# }
```

Dropping an async mutation future before the worker sends it prevents the send.
Dropping it after a send cannot cancel server execution because protocol v3 has
no mutation-cancel message. The worker keeps the mutation identity until it
settles or reaches its deadline.

## Reconnect and mutation identity

After a network loss the client waits 250 ms, doubles the delay after each
failed attempt, and caps it at 10 seconds. A valid `welcome` resets the delay.
It keeps the client ID, active subscriptions, last cookie, and each unsettled
mutation.

Mutation replay always reuses the exact `(mutId, ref, args)` tuple. The server
deduplicates that tuple. The client never retries a settled server error, even
when its code is marked retryable, and never creates a replacement mutation ID
after an ambiguous send.

The default mutation deadline is 60 seconds and includes reconnect time. If it
expires, the error kind is `MutationOutcomeUnknown`, the code is
`CDB_MUTATION_OUTCOME_UNKNOWN`, and `Error::mutation_id()` returns the ID needed
for reconciliation. Use `mutate_with_id` when the application must persist the
ID before dispatch. Chardb currently retains mutation replay records for 24
hours, so a mutation ID is not a permanent idempotency key.

Cookie-backed rows stay visible for at most 30 seconds after the first
disconnect. If the server does not replay a subscription in that window, the
client clears those rows, emits `SubscriptionEvent::Refetching`, drops the stale
cookie when safe, and asks for a fresh snapshot.

## Authentication

`ClientConfig::new` accepts a synchronous token provider. It runs on the
dedicated network thread, never on an async executor thread. Keep the provider
bounded, and return an owned error message without including the token.

The client decodes `sub` and `exp` only to schedule refresh 60 seconds before
expiry. It does not trust those claims. The Gateway verifies every token. A
refresh must keep the same subject, extend the expiry, and receive the
protocol's `mustRefetch` acknowledgment with reason `authChanged`. The refresh
acknowledgment has its own 10-second default deadline.

Call `refresh_auth` to rotate early. A principal change requires a new client.
`ClientConfig` and client errors never include JWT text in `Debug` or `Display`.

## TLS and plaintext

`wss://` uses Rustls on every supported operating system. There is no fallback
to plaintext and no option that disables certificate or hostname checks.

`ws://` is accepted for `localhost`, `127.0.0.1`, and `::1`. A non-loopback
plaintext endpoint requires `allow_plaintext_non_loopback(true)`, which is
intended for a trusted private network during development. The client does not
implement HTTP proxy tunneling or redirect following in this release.

TCP connect, TLS negotiation, the WebSocket upgrade, and the Chardb welcome are
bounded by configuration. Operating system DNS lookup time is outside Rust's
`TcpStream` timeout on some platforms.

## Subscription behavior

Snapshots replace the full row set and receive an `ack`. Duplicate snapshots
receive another `ack` without replacing rows. A `poke` applies all patches
atomically, injects the wire `rowKey` as `__key` for put and edit patches, then
emits the complete current row set as `SubscriptionEvent::Update`.

Dropping a subscription sends `unsub` on a best-effort basis. The event channel
is bounded. If a consumer stops reading and fills it, the worker retires that
local subscription instead of letting network input allocate memory without a
limit.

The wire module decodes presence and stream messages because they belong to
protocol version 3. The public client does not send them. The current Gateway
does not expose those operations as supported product APIs.

## Limits

The client enforces the same resource bounds as the TypeScript SDK:

- 1 MiB inbound and outbound text messages
- 512 KiB, 4,096 aggregate members, and 99 nesting levels per argument value
- 64 active subscriptions
- 4,096 rows and 512 KiB per subscription
- 4,096 patches and 512 KiB per patch batch
- 8 MiB total retained subscription rows
- 32 unsettled mutations

Rust integers outside JavaScript's safe range are rejected. JSON numbers must
be finite and cannot be negative zero.

## Contract tests

The committed protocol corpus is read by both `src/wire.ts` and the Rust wire
module. It covers every protocol-v3 tag and the additive normalization rules.
The Rust session tests run the same reconnect, replay, patch, auth, and timeout
scenario through blocking and async clients.

`examples/workerd_conformance.rs` is also launched by the repository's Gateway
JWT harness when `CHARDB_RUST_CONFORMANCE_BIN` points to the compiled example.
That path runs against the real Miniflare/Workerd Gateway, Catalog, Cdb shard,
JWKS verifier, registered query, and mutation handler.
