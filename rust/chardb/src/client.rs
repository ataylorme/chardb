use std::{
    collections::{HashMap, HashSet},
    io,
    marker::PhantomData,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use http::Uri;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tungstenite::{
    client_tls_with_config,
    protocol::{Message, WebSocketConfig},
    stream::MaybeTlsStream,
    Connector, WebSocket,
};
use uuid::Uuid;

use crate::{
    wire::{
        decode_down, encode_up, validate_json, validate_reference, Down, MutationResult,
        RefetchReason, RowPatch, RowPatchOp, SafeId, Up, PROTOCOL_VERSION,
    },
    Error, ErrorKind, Result,
};

const MAX_INBOUND_BYTES: usize = 1024 * 1024;
const MAX_ARGUMENT_BYTES: usize = 512 * 1024;
const MAX_ARGUMENT_MEMBERS: usize = 4096;
const MAX_ARGUMENT_DEPTH: usize = 99;
const MAX_ACTIVE_SUBSCRIPTIONS: usize = 64;
const MAX_SUBSCRIPTION_ROWS: usize = 4096;
const MAX_SUBSCRIPTION_BYTES: usize = 512 * 1024;
const MAX_PATCHES_PER_BATCH: usize = 4096;
const MAX_PATCH_BATCH_BYTES: usize = 512 * 1024;
const MAX_PENDING_MUTATIONS: usize = 32;
const MAX_QUEUED_COMMANDS: usize = 128;
const MAX_RETAINED_QUERY_BYTES: usize = 8 * 1024 * 1024;
const RECONNECT_INITIAL: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(10);
const RESUME_WINDOW: Duration = Duration::from_secs(30);
const IO_POLL: Duration = Duration::from_millis(5);
const AUTH_REFRESH_LEAD: Duration = Duration::from_secs(60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

type TokenProvider = Arc<dyn Fn() -> std::result::Result<String, String> + Send + Sync>;
type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Settings shared by the blocking and async clients.
#[derive(Clone)]
pub struct ClientConfig {
    endpoint: String,
    token_provider: TokenProvider,
    client_id: Option<String>,
    connect_timeout: Duration,
    welcome_timeout: Duration,
    mutation_timeout: Duration,
    auth_refresh_timeout: Duration,
    allow_plaintext_non_loopback: bool,
    tls_config: Option<Arc<rustls::ClientConfig>>,
}

impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClientConfig")
            .field("endpoint", &self.endpoint)
            .field("client_id", &self.client_id)
            .field("connect_timeout", &self.connect_timeout)
            .field("welcome_timeout", &self.welcome_timeout)
            .field("mutation_timeout", &self.mutation_timeout)
            .field("auth_refresh_timeout", &self.auth_refresh_timeout)
            .field(
                "allow_plaintext_non_loopback",
                &self.allow_plaintext_non_loopback,
            )
            .field("custom_tls_config", &self.tls_config.is_some())
            .finish_non_exhaustive()
    }
}

impl ClientConfig {
    /// Create a config with a refreshable JWT provider.
    ///
    /// The provider runs on the client's dedicated network thread. Its error
    /// text may be reported, but the returned JWT is never formatted or logged.
    pub fn new<F, E>(endpoint: impl Into<String>, token_provider: F) -> Self
    where
        F: Fn() -> std::result::Result<String, E> + Send + Sync + 'static,
        E: std::fmt::Display,
    {
        Self {
            endpoint: endpoint.into(),
            token_provider: Arc::new(move || token_provider().map_err(|error| error.to_string())),
            client_id: None,
            connect_timeout: Duration::from_secs(10),
            welcome_timeout: Duration::from_secs(10),
            mutation_timeout: Duration::from_secs(60),
            auth_refresh_timeout: Duration::from_secs(10),
            allow_plaintext_non_loopback: false,
            tls_config: None,
        }
    }

    /// Create a config with a fixed token. Expiring tokens should use [`Self::new`].
    #[must_use]
    pub fn with_token(endpoint: impl Into<String>, token: impl Into<String>) -> Self {
        let token = token.into();
        Self::new(endpoint, move || {
            Ok::<_, std::convert::Infallible>(token.clone())
        })
    }

    #[must_use]
    pub fn client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    #[must_use]
    pub const fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    #[must_use]
    pub const fn welcome_timeout(mut self, timeout: Duration) -> Self {
        self.welcome_timeout = timeout;
        self
    }

    #[must_use]
    pub const fn mutation_timeout(mut self, timeout: Duration) -> Self {
        self.mutation_timeout = timeout;
        self
    }

    #[must_use]
    pub const fn auth_refresh_timeout(mut self, timeout: Duration) -> Self {
        self.auth_refresh_timeout = timeout;
        self
    }

    /// Permit `ws://` for a non-loopback host. This never weakens `wss://`.
    #[must_use]
    pub const fn allow_plaintext_non_loopback(mut self, allow: bool) -> Self {
        self.allow_plaintext_non_loopback = allow;
        self
    }

    /// Use a custom Rustls configuration for `wss://` connections.
    ///
    /// This supports private certificate authorities, certificate pinning,
    /// and client certificates without changing the transport API.
    #[must_use]
    pub fn tls_config(mut self, config: Arc<rustls::ClientConfig>) -> Self {
        self.tls_config = Some(config);
        self
    }

    fn validate(&self) -> Result<()> {
        for (name, duration) in [
            ("connect timeout", self.connect_timeout),
            ("welcome timeout", self.welcome_timeout),
            ("mutation timeout", self.mutation_timeout),
            ("auth refresh timeout", self.auth_refresh_timeout),
        ] {
            if duration.is_zero() {
                return Err(Error::local(
                    ErrorKind::Configuration,
                    format!("{name} must be positive"),
                ));
            }
        }
        let _: Uri = self.endpoint.parse().map_err(|error| {
            Error::local(
                ErrorKind::Configuration,
                format!("invalid endpoint: {error}"),
            )
        })?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
#[non_exhaustive]
pub enum ConnectionState {
    Connecting = 0,
    Open = 1,
    Reconnecting = 2,
    Closed = 3,
}

impl ConnectionState {
    fn from_byte(value: u8) -> Self {
        match value {
            0 => Self::Connecting,
            1 => Self::Open,
            2 => Self::Reconnecting,
            _ => Self::Closed,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum SubscriptionEvent<T> {
    Snapshot { rows: Vec<T> },
    Update { rows: Vec<T> },
    Refetching { reason: RefetchReason },
    Retrying { error: Error, retry_in: Duration },
    Error(Error),
    Closed,
}

enum RawSubscriptionEvent {
    Snapshot(Vec<Value>),
    Update(Vec<Value>),
    Refetching(RefetchReason),
    Retrying(Error, Duration),
    Error(Error),
    Closed,
}

struct Inner {
    commands: flume::Sender<Command>,
    state: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    next_sub_id: AtomicU64,
    active_subscriptions: Arc<AtomicUsize>,
    mutation_timeout: Duration,
}

impl Inner {
    fn state(&self) -> ConnectionState {
        ConnectionState::from_byte(self.state.load(Ordering::Acquire))
    }

    fn subscribe<TArgs, TRow>(
        &self,
        reference: &str,
        args: &TArgs,
    ) -> Result<SubscriptionCore<TRow>>
    where
        TArgs: Serialize + ?Sized,
        TRow: DeserializeOwned,
    {
        if self.stop.load(Ordering::Acquire) {
            return Err(closed_error());
        }
        validate_reference(reference)?;
        let args = snapshot_args(args)?;
        reserve_subscription(&self.active_subscriptions)?;
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let id = match SafeId::new(id) {
            Ok(id) => id,
            Err(error) => {
                self.active_subscriptions.fetch_sub(1, Ordering::AcqRel);
                return Err(error);
            }
        };
        let (events, receiver) = flume::bounded(16);
        if let Err(error) = self.commands.try_send(Command::Subscribe {
            id,
            reference: reference.to_owned(),
            args,
            events,
        }) {
            self.active_subscriptions.fetch_sub(1, Ordering::AcqRel);
            return Err(command_send_error(&error));
        }
        Ok(SubscriptionCore {
            id,
            commands: self.commands.clone(),
            receiver,
            active_subscriptions: Arc::clone(&self.active_subscriptions),
            ended: false,
            marker: PhantomData,
        })
    }

    fn begin_mutation<TArgs>(
        &self,
        reference: &str,
        args: &TArgs,
        mutation_id: Option<String>,
    ) -> Result<flume::Receiver<Result<Value>>>
    where
        TArgs: Serialize + ?Sized,
    {
        if self.stop.load(Ordering::Acquire) {
            return Err(closed_error());
        }
        validate_reference(reference)?;
        let args = snapshot_args(args)?;
        let mutation_id = mutation_id.unwrap_or_else(|| Uuid::now_v7().to_string());
        if mutation_id.is_empty() {
            return Err(Error::local(
                ErrorKind::Configuration,
                "mutation id must not be empty",
            ));
        }
        let (response, receiver) = flume::bounded(1);
        self.commands
            .try_send(Command::Mutate {
                mutation_id,
                reference: reference.to_owned(),
                args,
                deadline: Instant::now() + self.mutation_timeout,
                response,
            })
            .map_err(|error| command_send_error(&error))?;
        Ok(receiver)
    }

    fn begin_refresh(&self) -> Result<flume::Receiver<Result<()>>> {
        if self.stop.load(Ordering::Acquire) {
            return Err(closed_error());
        }
        let (response, receiver) = flume::bounded(1);
        self.commands
            .try_send(Command::RefreshAuth { response })
            .map_err(|error| command_send_error(&error))?;
        Ok(receiver)
    }

    fn close(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(feature = "sync")]
#[derive(Clone)]
pub struct Client(Arc<Inner>);

#[cfg(feature = "sync")]
impl Client {
    /// Connect and wait for the authenticated protocol-v3 welcome message.
    ///
    /// # Errors
    ///
    /// Returns configuration, authentication, transport, timeout, or protocol errors.
    pub fn connect(config: ClientConfig) -> Result<Self> {
        let (inner, ready) = spawn_session(config)?;
        ready.recv().map_err(|_| closed_error())??;
        Ok(Self(inner))
    }

    #[must_use]
    pub fn state(&self) -> ConnectionState {
        self.0.state()
    }

    /// Start a typed live query.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid arguments, capacity exhaustion, or a closed client.
    pub fn subscribe<TArgs, TRow>(
        &self,
        reference: &str,
        args: &TArgs,
    ) -> Result<Subscription<TRow>>
    where
        TArgs: Serialize + ?Sized,
        TRow: DeserializeOwned,
    {
        self.0.subscribe(reference, args).map(Subscription)
    }

    /// Run a typed mutation with a generated stable mutation ID.
    ///
    /// # Errors
    ///
    /// Returns validation, server, timeout, transport, or result decoding errors.
    pub fn mutate<TArgs, TResult>(&self, reference: &str, args: &TArgs) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        self.mutate_inner(reference, args, None)
    }

    /// Run a typed mutation with an application-supplied stable mutation ID.
    ///
    /// # Errors
    ///
    /// Returns validation, server, timeout, transport, or result decoding errors.
    pub fn mutate_with_id<TArgs, TResult>(
        &self,
        reference: &str,
        args: &TArgs,
        mutation_id: impl Into<String>,
    ) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        self.mutate_inner(reference, args, Some(mutation_id.into()))
    }

    fn mutate_inner<TArgs, TResult>(
        &self,
        reference: &str,
        args: &TArgs,
        mutation_id: Option<String>,
    ) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        let receiver = self.0.begin_mutation(reference, args, mutation_id)?;
        let value = receiver.recv().map_err(|_| closed_error())??;
        deserialize_result(value)
    }

    /// Refresh the session JWT and wait for the server acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns an error if refresh validation, transport, or acknowledgement fails.
    pub fn refresh_auth(&self) -> Result<()> {
        self.0.begin_refresh()?.recv().map_err(|_| closed_error())?
    }

    pub fn close(&self) {
        self.0.close();
    }
}

#[cfg(feature = "async")]
#[derive(Clone)]
pub struct AsyncClient(Arc<Inner>);

#[cfg(feature = "async")]
impl AsyncClient {
    /// Connect and wait asynchronously for the authenticated protocol-v3 welcome message.
    ///
    /// # Errors
    ///
    /// Returns configuration, authentication, transport, timeout, or protocol errors.
    pub async fn connect(config: ClientConfig) -> Result<Self> {
        let (inner, ready) = spawn_session(config)?;
        ready.recv_async().await.map_err(|_| closed_error())??;
        Ok(Self(inner))
    }

    #[must_use]
    pub fn state(&self) -> ConnectionState {
        self.0.state()
    }

    /// Start a typed live query.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid arguments, capacity exhaustion, or a closed client.
    pub fn subscribe<TArgs, TRow>(
        &self,
        reference: &str,
        args: &TArgs,
    ) -> Result<AsyncSubscription<TRow>>
    where
        TArgs: Serialize + ?Sized,
        TRow: DeserializeOwned,
    {
        self.0.subscribe(reference, args).map(AsyncSubscription)
    }

    /// Run a typed mutation with a generated stable mutation ID.
    ///
    /// # Errors
    ///
    /// Returns validation, server, timeout, transport, or result decoding errors.
    pub async fn mutate<TArgs, TResult>(&self, reference: &str, args: &TArgs) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        self.mutate_inner(reference, args, None).await
    }

    /// Run a typed mutation with an application-supplied stable mutation ID.
    ///
    /// # Errors
    ///
    /// Returns validation, server, timeout, transport, or result decoding errors.
    pub async fn mutate_with_id<TArgs, TResult>(
        &self,
        reference: &str,
        args: &TArgs,
        mutation_id: impl Into<String>,
    ) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        self.mutate_inner(reference, args, Some(mutation_id.into()))
            .await
    }

    async fn mutate_inner<TArgs, TResult>(
        &self,
        reference: &str,
        args: &TArgs,
        mutation_id: Option<String>,
    ) -> Result<TResult>
    where
        TArgs: Serialize + ?Sized,
        TResult: DeserializeOwned,
    {
        let receiver = self.0.begin_mutation(reference, args, mutation_id)?;
        let value = receiver.recv_async().await.map_err(|_| closed_error())??;
        deserialize_result(value)
    }

    /// Refresh the session JWT and wait asynchronously for the server acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns an error if refresh validation, transport, or acknowledgement fails.
    pub async fn refresh_auth(&self) -> Result<()> {
        self.0
            .begin_refresh()?
            .recv_async()
            .await
            .map_err(|_| closed_error())?
    }

    pub fn close(&self) {
        self.0.close();
    }
}

struct SubscriptionCore<T> {
    id: SafeId,
    commands: flume::Sender<Command>,
    receiver: flume::Receiver<RawSubscriptionEvent>,
    active_subscriptions: Arc<AtomicUsize>,
    ended: bool,
    marker: PhantomData<fn() -> T>,
}

impl<T: DeserializeOwned> SubscriptionCore<T> {
    fn decode(&mut self, event: RawSubscriptionEvent) -> Result<SubscriptionEvent<T>> {
        match event {
            RawSubscriptionEvent::Snapshot(rows) => Ok(SubscriptionEvent::Snapshot {
                rows: decode_rows(rows)?,
            }),
            RawSubscriptionEvent::Update(rows) => Ok(SubscriptionEvent::Update {
                rows: decode_rows(rows)?,
            }),
            RawSubscriptionEvent::Refetching(reason) => {
                Ok(SubscriptionEvent::Refetching { reason })
            }
            RawSubscriptionEvent::Retrying(error, retry_in) => {
                Ok(SubscriptionEvent::Retrying { error, retry_in })
            }
            RawSubscriptionEvent::Error(error) => {
                self.ended = true;
                Ok(SubscriptionEvent::Error(error))
            }
            RawSubscriptionEvent::Closed => {
                self.ended = true;
                Ok(SubscriptionEvent::Closed)
            }
        }
    }
}

impl<T> Drop for SubscriptionCore<T> {
    fn drop(&mut self) {
        self.active_subscriptions.fetch_sub(1, Ordering::AcqRel);
        let _ = self.commands.try_send(Command::Unsubscribe { id: self.id });
    }
}

#[cfg(feature = "sync")]
pub struct Subscription<T>(SubscriptionCore<T>);

#[cfg(feature = "sync")]
impl<T: DeserializeOwned> Subscription<T> {
    /// Wait for and decode the next subscription event.
    ///
    /// # Errors
    ///
    /// Returns an error if the session closes unexpectedly or a row does not match `T`.
    pub fn recv(&mut self) -> Result<SubscriptionEvent<T>> {
        if self.0.ended {
            return Ok(SubscriptionEvent::Closed);
        }
        let event = self.0.receiver.recv().map_err(|_| closed_error())?;
        self.0.decode(event)
    }

    /// Wait up to `timeout` for the next subscription event.
    ///
    /// # Errors
    ///
    /// Returns an error if the session closes unexpectedly or a row does not match `T`.
    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<Option<SubscriptionEvent<T>>> {
        if self.0.ended {
            return Ok(Some(SubscriptionEvent::Closed));
        }
        match self.0.receiver.recv_timeout(timeout) {
            Ok(event) => self.0.decode(event).map(Some),
            Err(flume::RecvTimeoutError::Timeout) => Ok(None),
            Err(flume::RecvTimeoutError::Disconnected) => Err(closed_error()),
        }
    }
}

#[cfg(feature = "async")]
pub struct AsyncSubscription<T>(SubscriptionCore<T>);

#[cfg(feature = "async")]
impl<T: DeserializeOwned> AsyncSubscription<T> {
    /// Wait asynchronously for and decode the next subscription event.
    ///
    /// # Errors
    ///
    /// Returns an error if the session closes unexpectedly or a row does not match `T`.
    pub async fn recv(&mut self) -> Result<SubscriptionEvent<T>> {
        if self.0.ended {
            return Ok(SubscriptionEvent::Closed);
        }
        let event = self
            .0
            .receiver
            .recv_async()
            .await
            .map_err(|_| closed_error())?;
        self.0.decode(event)
    }
}

enum Command {
    Subscribe {
        id: SafeId,
        reference: String,
        args: Value,
        events: flume::Sender<RawSubscriptionEvent>,
    },
    Unsubscribe {
        id: SafeId,
    },
    Mutate {
        mutation_id: String,
        reference: String,
        args: Value,
        deadline: Instant,
        response: flume::Sender<Result<Value>>,
    },
    RefreshAuth {
        response: flume::Sender<Result<()>>,
    },
}

struct SubRecord {
    reference: String,
    args: Value,
    rows: Vec<Value>,
    events: flume::Sender<RawSubscriptionEvent>,
    last_snapshot_cookie: Option<String>,
    refetch_due: Option<Instant>,
    refetch_backoff: Duration,
}

struct PendingMutation {
    reference: String,
    args: Value,
    deadline: Instant,
    response: flume::Sender<Result<Value>>,
    sent_once: bool,
    in_flight: bool,
}

#[derive(Clone)]
struct JwtClaims {
    subject: String,
    expires_at: SystemTime,
}

struct PendingRefresh {
    claims: JwtClaims,
    deadline: Instant,
    response: Option<flume::Sender<Result<()>>>,
    server_acknowledged: bool,
    awaiting_subscriptions: HashSet<u64>,
}

struct Session {
    config: ClientConfig,
    endpoint: String,
    client_id: String,
    commands: flume::Receiver<Command>,
    state: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    subscriptions: HashMap<u64, SubRecord>,
    mutations: HashMap<String, PendingMutation>,
    last_cookie: Option<String>,
    current_claims: Option<JwtClaims>,
    pending_refresh: Option<PendingRefresh>,
    resume_deadline: Option<Instant>,
    resume_cookie: Option<String>,
    retained_subscriptions: HashSet<u64>,
}

enum LoopExit {
    Disconnect,
    Stop,
    Terminal(Error),
}

fn spawn_session(config: ClientConfig) -> Result<(Arc<Inner>, flume::Receiver<Result<()>>)> {
    config.validate()?;
    let client_id = config
        .client_id
        .clone()
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    validate_client_id(&client_id)?;
    let endpoint = endpoint_with_client_id(
        &config.endpoint,
        &client_id,
        config.allow_plaintext_non_loopback,
    )?;
    let (commands_tx, commands_rx) = flume::bounded(MAX_QUEUED_COMMANDS);
    let (ready_tx, ready_rx) = flume::bounded(1);
    let state = Arc::new(AtomicU8::new(ConnectionState::Connecting as u8));
    let stop = Arc::new(AtomicBool::new(false));
    let active_subscriptions = Arc::new(AtomicUsize::new(0));
    let inner = Arc::new(Inner {
        commands: commands_tx,
        state: Arc::clone(&state),
        stop: Arc::clone(&stop),
        next_sub_id: AtomicU64::new(1),
        active_subscriptions,
        mutation_timeout: config.mutation_timeout,
    });
    thread::Builder::new()
        .name("chardb-session".to_owned())
        .spawn(move || {
            let mut session = Session {
                config,
                endpoint,
                client_id,
                commands: commands_rx,
                state,
                stop,
                subscriptions: HashMap::new(),
                mutations: HashMap::new(),
                last_cookie: None,
                current_claims: None,
                pending_refresh: None,
                resume_deadline: None,
                resume_cookie: None,
                retained_subscriptions: HashSet::new(),
            };
            session.run(&ready_tx);
        })
        .map_err(|error| {
            Error::local(
                ErrorKind::Transport,
                format!("failed to start session thread: {error}"),
            )
        })?;
    Ok((inner, ready_rx))
}

impl Session {
    fn run(&mut self, ready: &flume::Sender<Result<()>>) {
        let initial = match self.connect_and_welcome() {
            Ok(socket) => socket,
            Err(error) => {
                self.set_state(ConnectionState::Closed);
                let _ = ready.send(Err(error));
                self.finish(closed_error());
                return;
            }
        };
        self.set_state(ConnectionState::Open);
        let _ = ready.send(Ok(()));
        let mut socket = initial;
        let mut backoff = RECONNECT_INITIAL;
        loop {
            match self.open_loop(&mut socket) {
                LoopExit::Stop => {
                    self.finish(closed_error());
                    return;
                }
                LoopExit::Terminal(error) => {
                    self.finish(error);
                    return;
                }
                LoopExit::Disconnect => {}
            }
            self.begin_reconnect();
            loop {
                let reconnect_at = Instant::now() + backoff;
                if self.wait_reconnect(reconnect_at) {
                    self.finish(closed_error());
                    return;
                }
                match self.connect_and_welcome() {
                    Ok(next) => {
                        socket = next;
                        backoff = RECONNECT_INITIAL;
                        self.set_state(ConnectionState::Open);
                        break;
                    }
                    Err(error) if is_reconnectable_error(&error) => {
                        backoff = (backoff * 2).min(RECONNECT_MAX);
                    }
                    Err(error) => {
                        self.finish(error);
                        return;
                    }
                }
            }
        }
    }

    fn connect_and_welcome(&mut self) -> Result<Socket> {
        let token = (self.config.token_provider)().map_err(|error| {
            Error::local(
                ErrorKind::Authentication,
                format!("JWT provider failed: {error}"),
            )
        })?;
        if token.is_empty() {
            return Err(Error::local(
                ErrorKind::Authentication,
                "JWT provider returned an empty token",
            ));
        }
        let claims = decode_jwt_claims(&token);
        if let (Some(old), Some(new)) = (&self.current_claims, &claims) {
            if old.subject != new.subject {
                return Err(Error::local(
                    ErrorKind::Authentication,
                    "JWT provider changed principal during reconnect",
                ));
            }
        }
        let mut socket = connect_socket(
            &self.endpoint,
            self.config.connect_timeout,
            self.config.tls_config.as_ref(),
        )?;
        let hello = Up::Hello {
            protocol_v: PROTOCOL_VERSION,
            client_id: self.client_id.clone(),
            resume: None,
            resume_from_cookie: self.last_cookie.clone().filter(|cookie| !cookie.is_empty()),
            jwt: token,
        };
        send_up(&mut socket, &hello)?;
        let deadline = Instant::now() + self.config.welcome_timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(Error::local(
                    ErrorKind::Timeout,
                    "timed out waiting for Chardb welcome",
                ));
            }
            match read_down(&mut socket) {
                Ok(Some(Down::Welcome {
                    protocol_v,
                    base_cookie,
                    resumed_from_cookie,
                    ..
                })) => {
                    if protocol_v != PROTOCOL_VERSION {
                        return Err(Error::local(
                            ErrorKind::Protocol,
                            "server selected an unsupported protocol",
                        ));
                    }
                    self.last_cookie = Some(resumed_from_cookie.unwrap_or(base_cookie));
                    self.current_claims = claims;
                    self.send_session_state(&mut socket)?;
                    return Ok(socket);
                }
                Ok(Some(Down::MustRefetch {
                    reason: RefetchReason::ProtocolMismatch,
                    ..
                })) => {
                    return Err(Error::local(
                        ErrorKind::Protocol,
                        "server rejected protocol version 3",
                    ));
                }
                Ok(Some(Down::Error {
                    code,
                    retryable,
                    correlation_id,
                    docs,
                    ..
                })) => {
                    return Err(Error::remote(
                        code,
                        retryable,
                        Some(correlation_id),
                        Some(docs),
                        "server rejected the Chardb handshake",
                    ));
                }
                Ok(Some(_)) => {
                    return Err(Error::local(
                        ErrorKind::Protocol,
                        "server sent work before welcome",
                    ));
                }
                Ok(None) => {}
                Err(error) => return Err(error),
            }
        }
    }

    fn send_session_state(&mut self, socket: &mut Socket) -> Result<()> {
        for (&id, subscription) in &self.subscriptions {
            send_up(
                socket,
                &Up::Subscribe {
                    sub_id: SafeId::new(id)?,
                    r#ref: subscription.reference.clone(),
                    args: subscription.args.clone(),
                    ttl_ms: None,
                },
            )?;
        }
        self.mutations
            .retain(|_, mutation| mutation.sent_once || !mutation.response.is_disconnected());
        for (mutation_id, mutation) in &mut self.mutations {
            send_up(
                socket,
                &Up::Mutate {
                    mutation_id: mutation_id.clone(),
                    r#ref: mutation.reference.clone(),
                    args: mutation.args.clone(),
                },
            )?;
            mutation.in_flight = true;
            mutation.sent_once = true;
        }
        Ok(())
    }

    fn open_loop(&mut self, socket: &mut Socket) -> LoopExit {
        let mut last_rx = Instant::now();
        let mut ping_sent: Option<Instant> = None;
        loop {
            if self.stop.load(Ordering::Acquire) {
                let _ = socket.close(None);
                return LoopExit::Stop;
            }
            if let Err(error) = self.expire_work() {
                return LoopExit::Terminal(error);
            }
            if let Err(error) = self.process_commands(Some(socket)) {
                if self.stop.load(Ordering::Acquire) {
                    return LoopExit::Stop;
                }
                return if is_reconnectable_error(&error) {
                    LoopExit::Disconnect
                } else {
                    LoopExit::Terminal(error)
                };
            }
            if let Err(error) = self.send_due_refetches(socket) {
                return if is_reconnectable_error(&error) {
                    LoopExit::Disconnect
                } else {
                    LoopExit::Terminal(error)
                };
            }
            if let Some(exit) = self.maybe_refresh_auth(socket) {
                return exit;
            }
            let now = Instant::now();
            if let Some(sent) = ping_sent {
                if now.duration_since(sent) >= HEARTBEAT_TIMEOUT && last_rx <= sent {
                    return LoopExit::Disconnect;
                }
            } else if now.duration_since(last_rx) >= HEARTBEAT_INTERVAL {
                if socket.send(Message::Ping(Vec::new().into())).is_err() {
                    return LoopExit::Disconnect;
                }
                ping_sent = Some(now);
            }
            match read_down(socket) {
                Ok(Some(message)) => {
                    last_rx = Instant::now();
                    ping_sent = None;
                    match self.handle_down(socket, message) {
                        Ok(()) => {}
                        Err(error) if is_reconnectable_error(&error) => {
                            return LoopExit::Disconnect
                        }
                        Err(error) => return LoopExit::Terminal(error),
                    }
                }
                Ok(None) => {}
                Err(error) if is_reconnectable_error(&error) => return LoopExit::Disconnect,
                Err(error) => return LoopExit::Terminal(error),
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn process_commands(&mut self, mut socket: Option<&mut Socket>) -> Result<()> {
        loop {
            let command = match self.commands.try_recv() {
                Ok(command) => command,
                Err(flume::TryRecvError::Empty) => break,
                Err(flume::TryRecvError::Disconnected) => {
                    self.stop.store(true, Ordering::Release);
                    break;
                }
            };
            match command {
                Command::Subscribe {
                    id,
                    reference,
                    args,
                    events,
                } => {
                    let id_value = id.get();
                    self.subscriptions.insert(
                        id_value,
                        SubRecord {
                            reference: reference.clone(),
                            args: args.clone(),
                            rows: Vec::new(),
                            events,
                            last_snapshot_cookie: None,
                            refetch_due: None,
                            refetch_backoff: Duration::from_millis(100),
                        },
                    );
                    if let Some(open) = socket.as_deref_mut() {
                        send_up(
                            open,
                            &Up::Subscribe {
                                sub_id: id,
                                r#ref: reference,
                                args,
                                ttl_ms: None,
                            },
                        )?;
                    }
                }
                Command::Unsubscribe { id } => {
                    self.release_retained(id.get());
                    self.fail_refresh_subscription(
                        id.get(),
                        Error::local(
                            ErrorKind::Closed,
                            "subscription closed while authentication refresh was refetching it",
                        ),
                    );
                    if self.subscriptions.remove(&id.get()).is_some() {
                        if let Some(open) = socket.as_deref_mut() {
                            send_up(open, &Up::Unsubscribe { sub_id: id })?;
                        }
                    }
                }
                Command::Mutate {
                    mutation_id,
                    reference,
                    args,
                    deadline,
                    response,
                } => {
                    if response.is_disconnected() {
                        continue;
                    }
                    if self.mutations.contains_key(&mutation_id) {
                        let _ = response.send(Err(Error::local(
                            ErrorKind::Configuration,
                            format!("mutation ID {mutation_id} is already pending"),
                        )));
                        continue;
                    }
                    if self.mutations.len() >= MAX_PENDING_MUTATIONS {
                        let _ = response.send(Err(Error::local(
                            ErrorKind::Capacity,
                            format!("cannot queue more than {MAX_PENDING_MUTATIONS} unsettled mutations"),
                        )));
                        continue;
                    }
                    let pending = PendingMutation {
                        reference: reference.clone(),
                        args: args.clone(),
                        deadline,
                        response,
                        sent_once: false,
                        in_flight: false,
                    };
                    self.mutations.insert(mutation_id.clone(), pending);
                    if let Some(open) = socket.as_deref_mut() {
                        let sent = send_up(
                            open,
                            &Up::Mutate {
                                mutation_id: mutation_id.clone(),
                                r#ref: reference,
                                args,
                            },
                        );
                        if let Some(pending) = self.mutations.get_mut(&mutation_id) {
                            pending.sent_once = sent.is_ok();
                            pending.in_flight = sent.is_ok();
                        }
                        sent?;
                    }
                }
                Command::RefreshAuth { response } => {
                    if self.pending_refresh.is_some() {
                        let _ = response.send(Err(Error::local(
                            ErrorKind::Authentication,
                            "authentication refresh is already pending",
                        )));
                    } else if let Some(open) = socket.as_deref_mut() {
                        self.start_auth_refresh(open, Some(response))?;
                    } else {
                        let _ = response.send(Err(Error::local(
                            ErrorKind::Transport,
                            "cannot refresh authentication while reconnecting",
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    fn handle_down(&mut self, socket: &mut Socket, message: Down) -> Result<()> {
        match message {
            Down::Welcome { .. } => Err(Error::local(
                ErrorKind::Protocol,
                "received duplicate welcome",
            )),
            Down::Snapshot {
                sub_id,
                cookie,
                rows,
            } => self.handle_snapshot(socket, sub_id, cookie, rows),
            Down::Poke {
                cookie,
                patches,
                mutation_results,
            } => {
                self.apply_patches(socket, patches)?;
                self.last_cookie = Some(cookie);
                if let Some(results) = mutation_results {
                    self.settle_mutations(results);
                }
                Ok(())
            }
            Down::MustRefetch { sub_ids, reason } => {
                self.handle_must_refetch(socket, sub_ids, reason)
            }
            Down::Error {
                code,
                sub_id,
                stream_request_id,
                retryable,
                correlation_id,
                docs,
            } => self.handle_remote_error(
                Error::remote(
                    code,
                    retryable,
                    Some(correlation_id),
                    Some(docs),
                    "Chardb rejected an operation",
                ),
                sub_id,
                stream_request_id,
            ),
            Down::Presence { .. } | Down::StreamChunk { .. } | Down::StreamEnd { .. } => Ok(()),
        }
    }

    fn handle_must_refetch(
        &mut self,
        socket: &mut Socket,
        sub_ids: Vec<SafeId>,
        reason: RefetchReason,
    ) -> Result<()> {
        let mut unique_ids = Vec::with_capacity(sub_ids.len());
        let mut seen = HashSet::with_capacity(sub_ids.len());
        for id in sub_ids {
            if seen.insert(id.get()) {
                unique_ids.push(id);
            }
        }
        if reason == RefetchReason::AuthChanged {
            self.begin_auth_refetch(&unique_ids)?;
        }
        self.refetch_subscriptions(socket, unique_ids, reason)?;
        self.settle_pending_refresh_if_complete();
        Ok(())
    }

    fn begin_auth_refetch(&mut self, sub_ids: &[SafeId]) -> Result<()> {
        if self.pending_refresh.is_none() {
            return Ok(());
        }
        if let Some(id) = sub_ids
            .iter()
            .find(|id| !self.subscriptions.contains_key(&id.get()))
        {
            let error = Error::local(
                ErrorKind::Protocol,
                format!("authChanged named unknown subscription {}", id.get()),
            );
            self.fail_pending_refresh(error.clone());
            return Err(error);
        }
        if let Some(pending) = self.pending_refresh.as_mut() {
            if pending.server_acknowledged {
                let error = Error::local(
                    ErrorKind::Protocol,
                    "received duplicate authChanged acknowledgement",
                );
                self.fail_pending_refresh(error.clone());
                return Err(error);
            }
            pending.server_acknowledged = true;
            pending.awaiting_subscriptions = sub_ids.iter().map(|id| id.get()).collect();
        }
        Ok(())
    }

    fn handle_remote_error(
        &mut self,
        error: Error,
        sub_id: Option<SafeId>,
        stream_request_id: Option<SafeId>,
    ) -> Result<()> {
        if sub_id.is_some() && stream_request_id.is_some() {
            return Err(Error::local(
                ErrorKind::Protocol,
                "error envelope has both subscription and stream scopes",
            ));
        }
        if let Some(id) = sub_id {
            self.handle_subscription_error(id, error);
            return Ok(());
        }
        if stream_request_id.is_some() {
            return Err(Error::local(
                ErrorKind::Protocol,
                "received an error for an unsupported stream request",
            ));
        }
        self.fail_pending_refresh(error.clone());
        Err(error)
    }

    fn handle_subscription_error(&mut self, id: SafeId, error: Error) {
        self.release_retained(id.get());
        if error.is_retryable() {
            let mut retire = false;
            if let Some(subscription) = self.subscriptions.get_mut(&id.get()) {
                subscription.rows.clear();
                subscription.last_snapshot_cookie = None;
                if subscription.refetch_due.is_none() {
                    let retry_in = subscription.refetch_backoff;
                    subscription.refetch_due = Some(Instant::now() + retry_in);
                    subscription.refetch_backoff = (retry_in * 2).min(Duration::from_secs(2));
                    retire = subscription
                        .events
                        .try_send(RawSubscriptionEvent::Retrying(error, retry_in))
                        .is_err();
                }
            }
            if retire {
                self.fail_refresh_subscription(id.get(), closed_error());
                self.subscriptions.remove(&id.get());
            }
        } else if let Some(subscription) = self.subscriptions.remove(&id.get()) {
            let _ = subscription
                .events
                .try_send(RawSubscriptionEvent::Error(error.clone()));
            self.fail_refresh_subscription(id.get(), error);
        }
    }

    fn refetch_subscriptions(
        &mut self,
        socket: &mut Socket,
        sub_ids: Vec<SafeId>,
        reason: RefetchReason,
    ) -> Result<()> {
        let mut retired = Vec::new();
        for id in sub_ids {
            self.release_retained(id.get());
            let Some(subscription) = self.subscriptions.get_mut(&id.get()) else {
                continue;
            };
            subscription.rows.clear();
            subscription.last_snapshot_cookie = None;
            if subscription
                .events
                .try_send(RawSubscriptionEvent::Refetching(reason))
                .is_err()
            {
                retired.push(id);
                continue;
            }
            if reason == RefetchReason::ShardsChanged {
                subscription.refetch_due = Some(Instant::now() + subscription.refetch_backoff);
                subscription.refetch_backoff =
                    (subscription.refetch_backoff * 2).min(Duration::from_secs(2));
            } else {
                subscription.refetch_due = None;
                send_up(
                    socket,
                    &Up::Subscribe {
                        sub_id: id,
                        r#ref: subscription.reference.clone(),
                        args: subscription.args.clone(),
                        ttl_ms: None,
                    },
                )?;
            }
        }
        for id in retired {
            self.subscriptions.remove(&id.get());
            self.fail_refresh_subscription(id.get(), closed_error());
            send_up(socket, &Up::Unsubscribe { sub_id: id })?;
        }
        Ok(())
    }

    fn settle_pending_refresh_if_complete(&mut self) {
        let complete = self.pending_refresh.as_ref().is_some_and(|pending| {
            pending.server_acknowledged && pending.awaiting_subscriptions.is_empty()
        });
        if !complete {
            return;
        }
        let mut pending = self
            .pending_refresh
            .take()
            .expect("pending refresh completion was checked");
        self.current_claims = Some(pending.claims);
        if let Some(response) = pending.response.take() {
            let _ = response.send(Ok(()));
        }
    }

    fn acknowledge_refresh_subscription(&mut self, id: u64) {
        if let Some(pending) = self.pending_refresh.as_mut() {
            pending.awaiting_subscriptions.remove(&id);
        }
        self.settle_pending_refresh_if_complete();
    }

    fn fail_pending_refresh(&mut self, error: Error) {
        if let Some(mut pending) = self.pending_refresh.take() {
            if let Some(response) = pending.response.take() {
                let _ = response.send(Err(error));
            }
        }
    }

    fn fail_refresh_subscription(&mut self, id: u64, error: Error) {
        let awaited = self
            .pending_refresh
            .as_ref()
            .is_some_and(|pending| pending.awaiting_subscriptions.contains(&id));
        if awaited {
            self.fail_pending_refresh(error);
        }
    }

    fn handle_snapshot(
        &mut self,
        socket: &mut Socket,
        sub_id: SafeId,
        cookie: String,
        rows: Vec<Value>,
    ) -> Result<()> {
        let id = sub_id.get();
        let Some(existing) = self.subscriptions.get(&id) else {
            return Ok(());
        };
        if existing.last_snapshot_cookie.as_deref() == Some(cookie.as_str()) {
            self.release_retained(id);
            send_up(socket, &Up::Ack { cookie })?;
            self.acknowledge_refresh_subscription(id);
            return Ok(());
        }
        validate_subscription_rows(&rows)?;
        self.validate_aggregate(Some((id, &rows)))?;
        self.release_retained(id);
        let subscription = self
            .subscriptions
            .get_mut(&id)
            .expect("subscription was checked");
        subscription.rows.clone_from(&rows);
        subscription.last_snapshot_cookie = Some(cookie.clone());
        subscription.refetch_due = None;
        subscription.refetch_backoff = Duration::from_millis(100);
        self.last_cookie = Some(cookie.clone());
        if subscription
            .events
            .try_send(RawSubscriptionEvent::Snapshot(rows))
            .is_err()
        {
            self.subscriptions.remove(&id);
            self.fail_refresh_subscription(id, closed_error());
            return send_up(socket, &Up::Unsubscribe { sub_id });
        }
        send_up(socket, &Up::Ack { cookie })?;
        self.acknowledge_refresh_subscription(id);
        Ok(())
    }

    fn apply_patches(&mut self, socket: &mut Socket, patches: Vec<RowPatch>) -> Result<()> {
        if patches.len() > MAX_PATCHES_PER_BATCH
            || serialized_size(&patches)? > MAX_PATCH_BATCH_BYTES
        {
            return Err(Error::local(
                ErrorKind::Protocol,
                "patch batch exceeds client limits",
            ));
        }
        let mut planned: HashMap<u64, Vec<Value>> = HashMap::new();
        for patch in patches {
            let id = patch.sub_id.get();
            let Some(subscription) = self.subscriptions.get(&id) else {
                continue;
            };
            let rows = planned
                .entry(id)
                .or_insert_with(|| subscription.rows.clone());
            let index = rows.iter().position(|row| {
                row.as_object()
                    .and_then(|object| object.get("__key"))
                    .and_then(Value::as_str)
                    == Some(patch.row_key.as_str())
            });
            if patch.op == RowPatchOp::Del {
                if patch.row.as_ref().is_some_and(|row| !row.is_object()) {
                    return Err(Error::local(
                        ErrorKind::Protocol,
                        "delete patch row must be an object when present",
                    ));
                }
                if let Some(index) = index {
                    rows.remove(index);
                }
                continue;
            }
            let mut object = patch
                .row
                .and_then(|row| row.as_object().cloned())
                .ok_or_else(|| {
                    Error::local(
                        ErrorKind::Protocol,
                        "put/edit patch must contain an object row",
                    )
                })?;
            object.insert("__key".to_owned(), Value::String(patch.row_key));
            let row = Value::Object(object);
            if let Some(index) = index {
                rows[index] = row;
            } else {
                rows.push(row);
            }
        }
        for rows in planned.values() {
            validate_subscription_rows(rows)?;
        }
        self.validate_planned_aggregate(&planned)?;
        let mut retired = Vec::new();
        for (id, rows) in planned {
            if let Some(subscription) = self.subscriptions.get_mut(&id) {
                subscription.rows.clone_from(&rows);
                if subscription
                    .events
                    .try_send(RawSubscriptionEvent::Update(rows))
                    .is_err()
                {
                    retired.push(id);
                }
            }
        }
        for id in retired {
            self.release_retained(id);
            self.subscriptions.remove(&id);
            send_up(
                socket,
                &Up::Unsubscribe {
                    sub_id: SafeId::new(id)?,
                },
            )?;
        }
        Ok(())
    }

    fn settle_mutations(&mut self, results: Vec<MutationResult>) {
        for result in results {
            match result {
                MutationResult::Success {
                    mutation_id,
                    result,
                    ..
                } => {
                    if let Some(pending) = self.mutations.remove(&mutation_id) {
                        let _ = pending.response.send(Ok(result));
                    }
                }
                MutationResult::Failure { mutation_id, error } => {
                    if let Some(pending) = self.mutations.remove(&mutation_id) {
                        let failure = Error::remote(
                            error.code,
                            error.retryable,
                            None,
                            Some(error.docs),
                            format!("mutation {mutation_id} failed"),
                        );
                        let _ = pending.response.send(Err(failure));
                    }
                }
            }
        }
    }

    fn begin_reconnect(&mut self) {
        self.set_state(ConnectionState::Reconnecting);
        self.fail_pending_refresh(Error::local(
            ErrorKind::Transport,
            "connection was lost while authentication refresh was pending",
        ));
        for mutation in self.mutations.values_mut() {
            mutation.in_flight = false;
        }
        if self.resume_deadline.is_none() {
            self.retained_subscriptions = self
                .subscriptions
                .iter()
                .filter_map(|(&id, sub)| {
                    (!sub.rows.is_empty() || sub.last_snapshot_cookie.is_some()).then_some(id)
                })
                .collect();
            if !self.retained_subscriptions.is_empty() {
                self.resume_deadline = Some(Instant::now() + RESUME_WINDOW);
                self.resume_cookie = self.last_cookie.clone();
            }
        }
    }

    fn wait_reconnect(&mut self, reconnect_at: Instant) -> bool {
        loop {
            if self.stop.load(Ordering::Acquire) {
                return true;
            }
            if let Err(error) = self.expire_work() {
                self.finish(error);
                return true;
            }
            if self.process_commands(None).is_err() {
                return true;
            }
            let now = Instant::now();
            if now >= reconnect_at {
                return false;
            }
            thread::sleep((reconnect_at - now).min(IO_POLL));
        }
    }

    fn expire_work(&mut self) -> Result<()> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .mutations
            .iter()
            .filter_map(|(id, mutation)| (now >= mutation.deadline).then_some(id.clone()))
            .collect();
        for id in expired {
            if let Some(mutation) = self.mutations.remove(&id) {
                let error = Error::mutation_unknown(
                    &id,
                    format!("mutation {id} reached its deadline; server outcome is unknown"),
                );
                let _ = mutation.response.send(Err(error));
            }
        }
        if self.resume_deadline.is_some_and(|deadline| now >= deadline) {
            self.expire_resume_state();
        }
        if self
            .pending_refresh
            .as_ref()
            .is_some_and(|refresh| now >= refresh.deadline)
        {
            let mut pending = self
                .pending_refresh
                .take()
                .expect("pending refresh was checked");
            let error = Error::local(
                ErrorKind::Timeout,
                "timed out waiting for auth refresh acknowledgement",
            );
            if let Some(response) = pending.response.take() {
                let _ = response.send(Err(error.clone()));
            }
            return Err(error);
        }
        Ok(())
    }

    fn expire_resume_state(&mut self) {
        let retained = std::mem::take(&mut self.retained_subscriptions);
        for id in retained {
            if let Some(subscription) = self.subscriptions.get_mut(&id) {
                subscription.rows.clear();
                subscription.last_snapshot_cookie = None;
                let _ = subscription
                    .events
                    .try_send(RawSubscriptionEvent::Refetching(RefetchReason::Lagged));
            }
        }
        if self.last_cookie == self.resume_cookie {
            self.last_cookie = None;
        }
        self.resume_deadline = None;
        self.resume_cookie = None;
    }

    fn release_retained(&mut self, id: u64) {
        self.retained_subscriptions.remove(&id);
        if self.retained_subscriptions.is_empty() {
            self.resume_deadline = None;
            self.resume_cookie = None;
        }
    }

    fn maybe_refresh_auth(&mut self, socket: &mut Socket) -> Option<LoopExit> {
        if self.pending_refresh.is_some() {
            return None;
        }
        let claims = self.current_claims.as_ref()?;
        let refresh_at = claims
            .expires_at
            .checked_sub(AUTH_REFRESH_LEAD)
            .unwrap_or(UNIX_EPOCH);
        if SystemTime::now() < refresh_at {
            return None;
        }
        match self.start_auth_refresh(socket, None) {
            Ok(()) => None,
            Err(error) => Some(LoopExit::Terminal(error)),
        }
    }

    fn start_auth_refresh(
        &mut self,
        socket: &mut Socket,
        response: Option<flume::Sender<Result<()>>>,
    ) -> Result<()> {
        let token = (self.config.token_provider)().map_err(|error| {
            Error::local(
                ErrorKind::Authentication,
                format!("JWT provider failed: {error}"),
            )
        })?;
        let claims = decode_jwt_claims(&token).ok_or_else(|| {
            Error::local(
                ErrorKind::Authentication,
                "refreshed JWT lacks valid sub and exp claims",
            )
        })?;
        if let Some(current) = &self.current_claims {
            if claims.subject != current.subject {
                return Err(Error::local(
                    ErrorKind::Authentication,
                    "refreshed JWT changed principal",
                ));
            }
            if claims.expires_at <= current.expires_at || claims.expires_at <= SystemTime::now() {
                return Err(Error::local(
                    ErrorKind::Authentication,
                    "refreshed JWT did not extend expiry",
                ));
            }
        }
        send_up(socket, &Up::UpdateAuth { jwt: token })?;
        self.pending_refresh = Some(PendingRefresh {
            claims,
            deadline: Instant::now() + self.config.auth_refresh_timeout,
            response,
            server_acknowledged: false,
            awaiting_subscriptions: HashSet::new(),
        });
        Ok(())
    }

    fn send_due_refetches(&mut self, socket: &mut Socket) -> Result<()> {
        let now = Instant::now();
        let due: Vec<u64> = self
            .subscriptions
            .iter()
            .filter_map(|(&id, subscription)| {
                subscription
                    .refetch_due
                    .is_some_and(|due| now >= due)
                    .then_some(id)
            })
            .collect();
        for id in due {
            let subscription = self
                .subscriptions
                .get_mut(&id)
                .expect("due subscription exists");
            subscription.refetch_due = None;
            send_up(
                socket,
                &Up::Subscribe {
                    sub_id: SafeId::new(id)?,
                    r#ref: subscription.reference.clone(),
                    args: subscription.args.clone(),
                    ttl_ms: None,
                },
            )?;
        }
        Ok(())
    }

    fn validate_aggregate(&self, replacement: Option<(u64, &Vec<Value>)>) -> Result<()> {
        let mut bytes = 0_usize;
        for (&id, subscription) in &self.subscriptions {
            let rows = replacement
                .filter(|(replace_id, _)| *replace_id == id)
                .map_or(&subscription.rows, |(_, rows)| rows);
            bytes = bytes.saturating_add(serialized_size(rows)?);
            if bytes > MAX_RETAINED_QUERY_BYTES {
                return Err(Error::local(
                    ErrorKind::Protocol,
                    "retained query state exceeds 8 MiB",
                ));
            }
        }
        Ok(())
    }

    fn validate_planned_aggregate(&self, planned: &HashMap<u64, Vec<Value>>) -> Result<()> {
        let mut bytes = 0_usize;
        for (&id, subscription) in &self.subscriptions {
            bytes = bytes.saturating_add(serialized_size(
                planned.get(&id).unwrap_or(&subscription.rows),
            )?);
            if bytes > MAX_RETAINED_QUERY_BYTES {
                return Err(Error::local(
                    ErrorKind::Protocol,
                    "retained query state exceeds 8 MiB",
                ));
            }
        }
        Ok(())
    }

    fn finish(&mut self, error: Error) {
        self.set_state(ConnectionState::Closed);
        for (_, subscription) in self.subscriptions.drain() {
            let event = if error.kind() == ErrorKind::Closed {
                RawSubscriptionEvent::Closed
            } else {
                RawSubscriptionEvent::Error(error.clone())
            };
            let _ = subscription.events.try_send(event);
        }
        for (mutation_id, mutation) in self.mutations.drain() {
            let result = if mutation.sent_once {
                Err(Error::mutation_unknown(
                    &mutation_id,
                    format!("client closed after mutation {mutation_id} dispatch; server outcome is unknown"),
                ))
            } else {
                Err(error.clone())
            };
            let _ = mutation.response.send(result);
        }
        if let Some(mut refresh) = self.pending_refresh.take() {
            if let Some(response) = refresh.response.take() {
                let _ = response.send(Err(error));
            }
        }
    }

    fn set_state(&self, state: ConnectionState) {
        self.state.store(state as u8, Ordering::Release);
    }
}

fn is_reconnectable_error(error: &Error) -> bool {
    error.is_retryable() || matches!(error.kind(), ErrorKind::Transport | ErrorKind::Timeout)
}

fn connect_socket(
    endpoint: &str,
    timeout: Duration,
    tls_config: Option<&Arc<rustls::ClientConfig>>,
) -> Result<Socket> {
    let uri: Uri = endpoint.parse().map_err(|error| {
        Error::local(
            ErrorKind::Configuration,
            format!("invalid endpoint: {error}"),
        )
    })?;
    let host = uri
        .host()
        .ok_or_else(|| Error::local(ErrorKind::Configuration, "endpoint has no host"))?;
    let port = uri.port_u16().unwrap_or_else(|| {
        if uri.scheme_str() == Some("wss") {
            443
        } else {
            80
        }
    });
    let started = Instant::now();
    let addresses = (host, port).to_socket_addrs().map_err(|error| {
        Error::local(ErrorKind::Transport, format!("DNS lookup failed: {error}"))
    })?;
    let mut last_error = None;
    for address in addresses {
        let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
            break;
        };
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => {
                let Some(handshake_timeout) = timeout.checked_sub(started.elapsed()) else {
                    break;
                };
                stream
                    .set_nodelay(true)
                    .map_err(|error| transport_io(&error))?;
                stream
                    .set_read_timeout(Some(handshake_timeout))
                    .map_err(|error| transport_io(&error))?;
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|error| transport_io(&error))?;
                let config = WebSocketConfig::default()
                    .max_message_size(Some(MAX_INBOUND_BYTES))
                    .max_frame_size(Some(MAX_INBOUND_BYTES));
                let connector = tls_config.cloned().map(Connector::Rustls);
                let (mut socket, _) =
                    client_tls_with_config(endpoint, stream, Some(config), connector).map_err(
                        |error| {
                            Error::local(
                                ErrorKind::Transport,
                                format!("WebSocket handshake failed: {error}"),
                            )
                        },
                    )?;
                set_socket_read_timeout(&mut socket, IO_POLL)
                    .map_err(|error| transport_io(&error))?;
                return Ok(socket);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(Error::local(
        ErrorKind::Transport,
        format!(
            "TCP connection failed: {}",
            last_error.map_or_else(|| "connect timeout".to_owned(), |error| error.to_string())
        ),
    ))
}

fn set_socket_read_timeout(socket: &mut Socket, timeout: Duration) -> io::Result<()> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream.set_read_timeout(Some(timeout)),
        MaybeTlsStream::Rustls(stream) => stream.sock.set_read_timeout(Some(timeout)),
        _ => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported WebSocket transport",
        )),
    }
}

fn send_up(socket: &mut Socket, message: &Up) -> Result<()> {
    let encoded = encode_up(message)?;
    if encoded.len() > MAX_INBOUND_BYTES {
        return Err(Error::local(
            ErrorKind::Configuration,
            "outbound message exceeds 1 MiB",
        ));
    }
    socket.send(Message::Text(encoded.into())).map_err(|error| {
        Error::local(
            ErrorKind::Transport,
            format!("WebSocket send failed: {error}"),
        )
    })
}

fn read_down(socket: &mut Socket) -> Result<Option<Down>> {
    match socket.read() {
        Ok(Message::Text(text)) => {
            if text.len() > MAX_INBOUND_BYTES {
                return Err(Error::local(
                    ErrorKind::Protocol,
                    "server message exceeds 1 MiB",
                ));
            }
            decode_down(&text).map(Some)
        }
        Ok(Message::Binary(_)) => Err(Error::local(
            ErrorKind::Protocol,
            "server sent a binary WebSocket message",
        )),
        Ok(Message::Close(_)) => Err(Error::local(ErrorKind::Transport, "WebSocket closed")),
        Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => Ok(None),
        Err(tungstenite::Error::Io(error))
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(Error::local(
            ErrorKind::Transport,
            format!("WebSocket receive failed: {error}"),
        )),
    }
}

fn endpoint_with_client_id(
    endpoint: &str,
    client_id: &str,
    allow_plaintext: bool,
) -> Result<String> {
    let uri: Uri = endpoint.parse().map_err(|error| {
        Error::local(
            ErrorKind::Configuration,
            format!("invalid endpoint: {error}"),
        )
    })?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| Error::local(ErrorKind::Configuration, "endpoint has no scheme"))?;
    if !matches!(scheme, "ws" | "wss") {
        return Err(Error::local(
            ErrorKind::Configuration,
            "endpoint scheme must be ws or wss",
        ));
    }
    let host = uri
        .host()
        .ok_or_else(|| Error::local(ErrorKind::Configuration, "endpoint has no host"))?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if scheme == "ws" && !loopback && !allow_plaintext {
        return Err(Error::local(
            ErrorKind::Configuration,
            "ws:// is limited to loopback hosts unless explicitly allowed",
        ));
    }
    let query = uri
        .path_and_query()
        .and_then(|value| value.query())
        .unwrap_or_default();
    if query
        .split('&')
        .filter_map(|pair| pair.split_once('=').map(|(key, _)| key).or(Some(pair)))
        .any(|key| key == "clientId")
    {
        return Err(Error::local(
            ErrorKind::Configuration,
            "endpoint must not already contain a clientId query parameter",
        ));
    }
    let separator = if query.is_empty() { '?' } else { '&' };
    Ok(format!("{endpoint}{separator}clientId={client_id}"))
}

fn validate_client_id(client_id: &str) -> Result<()> {
    if client_id.is_empty()
        || client_id.len() > 256
        || client_id.trim() != client_id
        || client_id.bytes().any(|byte| byte <= 31 || byte == 127)
        || !client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(Error::local(ErrorKind::Configuration, "invalid client id"));
    }
    Ok(())
}

#[allow(clippy::items_after_statements)]
fn snapshot_args<T: Serialize + ?Sized>(args: &T) -> Result<Value> {
    let value = serde_json::to_value(args).map_err(|error| {
        Error::local(
            ErrorKind::Configuration,
            format!("arguments are not JSON: {error}"),
        )
    })?;
    validate_json(&value, MAX_ARGUMENT_DEPTH)?;
    let mut members = 0_usize;
    fn count(value: &Value, members: &mut usize) -> Result<()> {
        match value {
            Value::Array(values) => {
                *members = members.saturating_add(values.len());
                for value in values {
                    count(value, members)?;
                }
            }
            Value::Object(values) => {
                *members = members.saturating_add(values.len());
                for value in values.values() {
                    count(value, members)?;
                }
            }
            Value::Number(number) => {
                if number
                    .as_f64()
                    .is_some_and(|number| number == 0.0 && number.is_sign_negative())
                {
                    return Err(Error::local(
                        ErrorKind::Configuration,
                        "arguments must not contain negative zero",
                    ));
                }
                if let Some(integer) = number.as_i64() {
                    if integer.unsigned_abs() > crate::wire::MAX_SAFE_INTEGER {
                        return Err(Error::local(
                            ErrorKind::Configuration,
                            "integer argument exceeds JavaScript's safe range",
                        ));
                    }
                } else if number
                    .as_u64()
                    .is_some_and(|integer| integer > crate::wire::MAX_SAFE_INTEGER)
                {
                    return Err(Error::local(
                        ErrorKind::Configuration,
                        "integer argument exceeds JavaScript's safe range",
                    ));
                }
            }
            Value::Null | Value::Bool(_) | Value::String(_) => {}
        }
        if *members > MAX_ARGUMENT_MEMBERS {
            return Err(Error::local(
                ErrorKind::Configuration,
                format!("arguments exceed {MAX_ARGUMENT_MEMBERS} aggregate members"),
            ));
        }
        Ok(())
    }
    count(&value, &mut members)?;
    if serialized_size(&value)? > MAX_ARGUMENT_BYTES {
        return Err(Error::local(
            ErrorKind::Configuration,
            "arguments exceed 512 KiB",
        ));
    }
    Ok(value)
}

fn validate_subscription_rows(rows: &Vec<Value>) -> Result<()> {
    if rows.len() > MAX_SUBSCRIPTION_ROWS || serialized_size(rows)? > MAX_SUBSCRIPTION_BYTES {
        return Err(Error::local(
            ErrorKind::Protocol,
            "subscription rows exceed client limits",
        ));
    }
    Ok(())
}

fn serialized_size<T: Serialize + ?Sized>(value: &T) -> Result<usize> {
    struct CountingWriter(usize);

    impl io::Write for CountingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(buffer.len());
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut writer = CountingWriter(0);
    serde_json::to_writer(&mut writer, value).map_err(|error| {
        Error::local(
            ErrorKind::Protocol,
            format!("failed to measure JSON: {error}"),
        )
    })?;
    Ok(writer.0)
}

fn reserve_subscription(active: &AtomicUsize) -> Result<()> {
    let mut current = active.load(Ordering::Acquire);
    loop {
        if current >= MAX_ACTIVE_SUBSCRIPTIONS {
            return Err(Error::local(
                ErrorKind::Capacity,
                format!("cannot open more than {MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions"),
            ));
        }
        match active.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Ok(()),
            Err(next) => current = next,
        }
    }
}

fn command_send_error<T>(error: &flume::TrySendError<T>) -> Error {
    match error {
        flume::TrySendError::Full(_) => Error::local(
            ErrorKind::Capacity,
            format!("client command queue is full ({MAX_QUEUED_COMMANDS} messages)"),
        ),
        flume::TrySendError::Disconnected(_) => closed_error(),
    }
}

fn decode_rows<T: DeserializeOwned>(rows: Vec<Value>) -> Result<Vec<T>> {
    rows.into_iter().map(deserialize_result).collect()
}

fn deserialize_result<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        Error::local(
            ErrorKind::Protocol,
            format!("response type mismatch: {error}"),
        )
    })
}

fn decode_jwt_claims(token: &str) -> Option<JwtClaims> {
    #[derive(Deserialize)]
    struct Claims {
        sub: String,
        exp: u64,
    }
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Claims = serde_json::from_slice(&decoded).ok()?;
    if claims.sub.is_empty() || claims.exp == 0 {
        return None;
    }
    Some(JwtClaims {
        subject: claims.sub,
        expires_at: UNIX_EPOCH.checked_add(Duration::from_secs(claims.exp))?,
    })
}

fn transport_io(error: &io::Error) -> Error {
    Error::local(
        ErrorKind::Transport,
        format!("socket setup failed: {error}"),
    )
}

fn closed_error() -> Error {
    Error::local(ErrorKind::Closed, "Chardb client is closed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_rejects_duplicate_client_id_and_remote_plaintext() {
        assert!(endpoint_with_client_id("ws://example.com/ws", "client", false).is_err());
        assert!(
            endpoint_with_client_id("wss://example.com/ws?clientId=old", "client", false).is_err()
        );
        assert_eq!(
            endpoint_with_client_id("ws://127.0.0.1/ws", "client", false).unwrap(),
            "ws://127.0.0.1/ws?clientId=client"
        );
    }

    #[test]
    fn argument_limits_reject_unsafe_integers_and_negative_zero() {
        assert!(snapshot_args(&serde_json::json!(9_007_199_254_740_992_u64)).is_err());
        assert!(snapshot_args(&-0.0_f64).is_err());
    }

    #[test]
    fn jwt_claims_are_decode_only_metadata() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"sub":"user-1","exp":4102444800}"#);
        let token = format!("e30.{claims}.signature");
        let decoded = decode_jwt_claims(&token).unwrap();
        assert_eq!(decoded.subject, "user-1");
    }
}
