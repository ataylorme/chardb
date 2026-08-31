use std::{fmt, marker::PhantomData};

/// A registered live query and its Rust argument and row types.
///
/// Applications normally declare these handles in one API module, then pass
/// them to [`crate::Client::subscribe`] or [`crate::AsyncClient::subscribe`].
/// The handle stores only the protocol reference and has no runtime allocation.
pub struct Query<Arguments: ?Sized, Row> {
    reference: &'static str,
    marker: PhantomData<fn(&Arguments) -> Row>,
}

impl<Arguments: ?Sized, Row> Query<Arguments, Row> {
    /// Declare a registered query.
    ///
    /// This checks the same minimum reference syntax as the wire codec. When
    /// called in a `const`, a malformed reference fails compilation.
    ///
    /// # Panics
    ///
    /// Panics if `reference` is empty or does not contain `#`.
    #[must_use]
    pub const fn new(reference: &'static str) -> Self {
        assert!(
            is_valid_reference(reference),
            "Chardb reference must be nonempty and contain '#'"
        );
        Self {
            reference,
            marker: PhantomData,
        }
    }

    /// Return the exact reference written to protocol v3's `ref` field.
    #[must_use]
    pub const fn reference(self) -> &'static str {
        self.reference
    }
}

/// A registered mutation and its Rust argument and result types.
///
/// Applications normally declare these handles in one API module, then pass
/// them to `mutate` or `mutate_with_id` on either client.
pub struct Mutation<Arguments: ?Sized, Output> {
    reference: &'static str,
    marker: PhantomData<fn(&Arguments) -> Output>,
}

impl<Arguments: ?Sized, Output> Mutation<Arguments, Output> {
    /// Declare a registered mutation.
    ///
    /// This checks the same minimum reference syntax as the wire codec. When
    /// called in a `const`, a malformed reference fails compilation.
    ///
    /// # Panics
    ///
    /// Panics if `reference` is empty or does not contain `#`.
    #[must_use]
    pub const fn new(reference: &'static str) -> Self {
        assert!(
            is_valid_reference(reference),
            "Chardb reference must be nonempty and contain '#'"
        );
        Self {
            reference,
            marker: PhantomData,
        }
    }

    /// Return the exact reference written to protocol v3's `ref` field.
    #[must_use]
    pub const fn reference(self) -> &'static str {
        self.reference
    }
}

/// Shared type information for query and mutation handles.
///
/// This trait supports operation introspection. Client methods accept the
/// concrete [`Query`] or [`Mutation`] type so the two cannot be mixed up.
pub trait Operation: Copy {
    type Arguments: ?Sized;
    type Output;

    fn reference(self) -> &'static str;
}

impl<Arguments: ?Sized, Row> Operation for Query<Arguments, Row> {
    type Arguments = Arguments;
    type Output = Row;

    fn reference(self) -> &'static str {
        self.reference
    }
}

impl<Arguments: ?Sized, Output> Operation for Mutation<Arguments, Output> {
    type Arguments = Arguments;
    type Output = Output;

    fn reference(self) -> &'static str {
        self.reference
    }
}

impl<Arguments: ?Sized, Row> Copy for Query<Arguments, Row> {}

impl<Arguments: ?Sized, Row> Clone for Query<Arguments, Row> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<Arguments: ?Sized, Row> fmt::Debug for Query<Arguments, Row> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Query")
            .field(&self.reference)
            .finish()
    }
}

impl<Arguments: ?Sized, Output> Copy for Mutation<Arguments, Output> {}

impl<Arguments: ?Sized, Output> Clone for Mutation<Arguments, Output> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<Arguments: ?Sized, Output> fmt::Debug for Mutation<Arguments, Output> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Mutation")
            .field(&self.reference)
            .finish()
    }
}

pub(crate) const fn is_valid_reference(reference: &str) -> bool {
    if reference.is_empty() {
        return false;
    }
    let bytes = reference.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'#' {
            return true;
        }
        index += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUERY: Query<(), String> = Query::new("queries.ts#messages");
    const MUTATION: Mutation<String, usize> = Mutation::new("mutations.ts#post");

    #[test]
    fn handles_keep_the_exact_wire_reference_without_storage() {
        assert_eq!(QUERY.reference(), "queries.ts#messages");
        assert_eq!(MUTATION.reference(), "mutations.ts#post");
        assert_eq!(std::mem::size_of_val(&QUERY), std::mem::size_of::<&str>());
        assert_eq!(format!("{QUERY:?}"), "Query(\"queries.ts#messages\")");
    }

    #[test]
    #[should_panic(expected = "Chardb reference must be nonempty and contain '#'")]
    fn runtime_declarations_reject_malformed_references() {
        let _ = Query::<(), ()>::new("queries.ts");
    }
}
