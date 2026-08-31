#![cfg(all(feature = "sync", feature = "async"))]

use std::{
    net::{TcpListener, TcpStream},
    thread,
};

use chardb_client::{
    wire::{decode_up, Up},
    AsyncClient, Client, ClientConfig, ConnectionState, SubscriptionEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tungstenite::{
    accept_hdr,
    handshake::server::{Request, Response},
    Message, WebSocket,
};

#[derive(Debug, Deserialize, PartialEq)]
struct Row {
    #[serde(rename = "__key")]
    key: String,
    body: String,
}

#[derive(Debug, Deserialize, PartialEq)]
struct MutationAck {
    id: String,
}

#[derive(Serialize)]
struct Args<'a> {
    #[serde(rename = "organizationId")]
    organization_id: &'a str,
}

fn jwt(subject: &str, expiry: u64) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"{subject}","exp":{expiry}}}"#));
    format!("e30.{payload}.signature")
}

fn read_up(socket: &mut WebSocket<TcpStream>) -> Up {
    loop {
        match socket.read().unwrap() {
            Message::Text(text) => return decode_up(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).unwrap(),
            other => panic!("unexpected client frame: {other:?}"),
        }
    }
}

fn send_json(socket: &mut WebSocket<TcpStream>, value: &serde_json::Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .unwrap();
}

#[allow(clippy::result_large_err)]
fn accept_client(listener: &TcpListener) -> (WebSocket<TcpStream>, String) {
    let stream = listener.accept().unwrap().0;
    let mut request_uri = None;
    let socket = accept_hdr(stream, |request: &Request, response: Response| {
        request_uri = Some(request.uri().to_string());
        Ok(response)
    })
    .unwrap();
    let uri = request_uri.unwrap();
    let client_id = uri
        .split('?')
        .nth(1)
        .and_then(|query| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("clientId="))
        })
        .unwrap()
        .to_owned();
    (socket, client_id)
}

fn spawn_contract_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}/ws", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut first, client_id) = accept_client(&listener);
        match read_up(&mut first) {
            Up::Hello {
                protocol_v,
                client_id: hello_id,
                resume_from_cookie,
                ..
            } => {
                assert_eq!(protocol_v, 3);
                assert_eq!(hello_id, client_id);
                assert_eq!(resume_from_cookie, None);
            }
            other => panic!("expected hello, got {other:?}"),
        }
        send_json(
            &mut first,
            &json!({"t":"welcome","protocolV":3,"baseCookie":format!("{client_id}:0"),"region":"test"}),
        );
        let sub_id = match read_up(&mut first) {
            Up::Subscribe {
                sub_id,
                r#ref,
                args,
                ..
            } => {
                assert_eq!(r#ref, "queries.ts#messages");
                assert_eq!(args, json!({"organizationId":"org-1"}));
                sub_id
            }
            other => panic!("expected subscription, got {other:?}"),
        };
        let snapshot_cookie = format!("{client_id}:1");
        send_json(
            &mut first,
            &json!({"t":"snapshot","subId":sub_id.get(),"cookie":snapshot_cookie,"rows":[{"__key":"message-1","body":"before"}]}),
        );
        assert!(matches!(read_up(&mut first), Up::Ack { cookie } if cookie == snapshot_cookie));
        let mutation_id = match read_up(&mut first) {
            Up::Mutate {
                mutation_id,
                r#ref,
                args,
            } => {
                assert_eq!(r#ref, "mutations.ts#post");
                assert_eq!(args, json!({"organizationId":"org-1"}));
                mutation_id
            }
            other => panic!("expected mutation, got {other:?}"),
        };
        assert_eq!(mutation_id, "stable-mutation-id");
        first.close(None).unwrap();

        let (mut second, reconnect_id) = accept_client(&listener);
        assert_eq!(reconnect_id, client_id);
        match read_up(&mut second) {
            Up::Hello {
                client_id: hello_id,
                resume_from_cookie,
                ..
            } => {
                assert_eq!(hello_id, client_id);
                assert_eq!(
                    resume_from_cookie.as_deref(),
                    Some(snapshot_cookie.as_str())
                );
            }
            other => panic!("expected reconnect hello, got {other:?}"),
        }
        send_json(
            &mut second,
            &json!({"t":"welcome","protocolV":3,"baseCookie":format!("{client_id}:0"),"resumedFromCookie":snapshot_cookie,"region":"test"}),
        );
        assert!(
            matches!(read_up(&mut second), Up::Subscribe { sub_id: replayed, .. } if replayed == sub_id)
        );
        assert!(
            matches!(read_up(&mut second), Up::Mutate { mutation_id: replayed, .. } if replayed == mutation_id)
        );
        send_json(
            &mut second,
            &json!({
                "t":"poke",
                "cookie":format!("{client_id}:2"),
                "patches":[{"op":"edit","subId":sub_id.get(),"rowKey":"message-1","row":{"body":"after"}}],
                "mutResults":[{"mutId":mutation_id,"ok":true,"result":{"id":"message-1"},"cookie":format!("{client_id}:2")}]
            }),
        );
        assert!(matches!(read_up(&mut second), Up::UpdateAuth { .. }));
        send_json(
            &mut second,
            &json!({"t":"mustRefetch","subIds":[],"reason":"authChanged"}),
        );
        let _ = second.close(None);
    });
    (endpoint, server)
}

fn config(endpoint: String) -> ClientConfig {
    let next = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    ClientConfig::new(endpoint, move || {
        let offset = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok::<_, std::convert::Infallible>(jwt("user-1", 4_102_444_800 + offset))
    })
}

#[test]
fn blocking_client_matches_reconnect_mutation_and_auth_contract() {
    let (endpoint, server) = spawn_contract_server();
    let client = Client::connect(config(endpoint)).unwrap();
    assert_eq!(client.state(), ConnectionState::Open);
    let mut subscription = client
        .subscribe::<_, Row>(
            "queries.ts#messages",
            &Args {
                organization_id: "org-1",
            },
        )
        .unwrap();
    assert!(matches!(
        subscription.recv().unwrap(),
        SubscriptionEvent::Snapshot { rows } if rows == vec![Row { key: "message-1".into(), body: "before".into() }]
    ));
    let result: MutationAck = client
        .mutate_with_id(
            "mutations.ts#post",
            &Args {
                organization_id: "org-1",
            },
            "stable-mutation-id",
        )
        .unwrap();
    assert_eq!(
        result,
        MutationAck {
            id: "message-1".into()
        }
    );
    assert!(matches!(
        subscription.recv().unwrap(),
        SubscriptionEvent::Update { rows } if rows == vec![Row { key: "message-1".into(), body: "after".into() }]
    ));
    client.refresh_auth().unwrap();
    client.close();
    server.join().unwrap();
}

#[test]
fn async_facade_runs_the_identical_session_contract_without_tokio() {
    let (endpoint, server) = spawn_contract_server();
    futures_lite::future::block_on(async move {
        let client = AsyncClient::connect(config(endpoint)).await.unwrap();
        let mut subscription = client
            .subscribe::<_, Row>(
                "queries.ts#messages",
                &Args {
                    organization_id: "org-1",
                },
            )
            .unwrap();
        assert!(matches!(
            subscription.recv().await.unwrap(),
            SubscriptionEvent::Snapshot { .. }
        ));
        let result: MutationAck = client
            .mutate_with_id(
                "mutations.ts#post",
                &Args {
                    organization_id: "org-1",
                },
                "stable-mutation-id",
            )
            .await
            .unwrap();
        assert_eq!(result.id, "message-1");
        assert!(matches!(
            subscription.recv().await.unwrap(),
            SubscriptionEvent::Update { .. }
        ));
        client.refresh_auth().await.unwrap();
        client.close();
    });
    server.join().unwrap();
}

#[test]
fn connect_failure_is_bounded_and_reported() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let started = std::time::Instant::now();
    let Err(error) = Client::connect(
        ClientConfig::with_token(format!("ws://{address}/ws"), "token")
            .connect_timeout(std::time::Duration::from_millis(200)),
    ) else {
        panic!("connection unexpectedly succeeded");
    };
    assert_eq!(error.kind(), chardb_client::ErrorKind::Transport);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
}
