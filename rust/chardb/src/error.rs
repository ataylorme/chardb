use std::fmt;

use crate::wire::CdbErrorCode;

/// Result type returned by this crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Stable classification for local and remote failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ErrorKind {
    Configuration,
    Authentication,
    Transport,
    Protocol,
    Remote,
    Timeout,
    MutationOutcomeUnknown,
    Closed,
    Capacity,
}

/// A `CharDB` client failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Error {
    kind: ErrorKind,
    message: String,
    code: Option<CdbErrorCode>,
    retryable: bool,
    correlation_id: Option<String>,
    docs: Option<String>,
    mutation_id: Option<String>,
}

impl Error {
    pub(crate) fn local(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            code: None,
            retryable: false,
            correlation_id: None,
            docs: None,
            mutation_id: None,
        }
    }

    #[cfg(feature = "client")]
    pub(crate) fn remote(
        code: CdbErrorCode,
        retryable: bool,
        correlation_id: Option<String>,
        docs: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind: if matches!(
                code,
                CdbErrorCode::AuthProfileIncompatible
                    | CdbErrorCode::AuthNotBound
                    | CdbErrorCode::CallerDenied
                    | CdbErrorCode::Forbidden
                    | CdbErrorCode::ForbiddenColumn
            ) {
                ErrorKind::Authentication
            } else {
                ErrorKind::Remote
            },
            message: message.into(),
            code: Some(code),
            retryable,
            correlation_id,
            docs,
            mutation_id: None,
        }
    }

    #[cfg(feature = "client")]
    pub(crate) fn mutation_unknown(
        mutation_id: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind: ErrorKind::MutationOutcomeUnknown,
            message: message.into(),
            code: Some(CdbErrorCode::MutationOutcomeUnknown),
            retryable: false,
            correlation_id: None,
            docs: Some(CdbErrorCode::MutationOutcomeUnknown.docs_url()),
            mutation_id: Some(mutation_id.into()),
        }
    }

    #[must_use]
    pub const fn kind(&self) -> ErrorKind {
        self.kind
    }

    #[must_use]
    pub const fn code(&self) -> Option<CdbErrorCode> {
        self.code
    }

    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        self.retryable
    }

    #[must_use]
    pub fn correlation_id(&self) -> Option<&str> {
        self.correlation_id.as_deref()
    }

    #[must_use]
    pub fn docs(&self) -> Option<&str> {
        self.docs.as_deref()
    }

    #[must_use]
    pub fn mutation_id(&self) -> Option<&str> {
        self.mutation_id.as_deref()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(code) = self.code {
            write!(formatter, "{}: {}", code.as_str(), self.message)
        } else {
            formatter.write_str(&self.message)
        }
    }
}

impl std::error::Error for Error {}
