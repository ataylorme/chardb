#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod error;
pub mod wire;

#[cfg(feature = "introspection")]
pub mod introspection;

#[cfg(feature = "client")]
mod client;

pub use error::{Error, ErrorKind, Result};

#[cfg(feature = "client")]
pub use client::{ClientConfig, ConnectionState, SubscriptionEvent};

#[cfg(feature = "sync")]
pub use client::{Client, Subscription};

#[cfg(feature = "async")]
pub use client::{AsyncClient, AsyncSubscription};
