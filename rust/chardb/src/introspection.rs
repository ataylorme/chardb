//! Optional JSON Schema descriptions for application argument and result types.

use serde::Serialize;

use crate::{wire::validate_reference, Result};

pub use schemars::{JsonSchema, Schema};

/// The argument and result schemas attached to one Chardb reference.
#[derive(Clone, Debug, Serialize)]
pub struct OperationSchema {
    pub reference: String,
    pub arguments: Schema,
    pub result: Schema,
}

/// Generate the JSON Schema 2020-12 document for a Rust type.
#[must_use]
pub fn schema_for<T: JsonSchema>() -> Schema {
    schemars::schema_for!(T)
}

/// Describe the typed contract used with `subscribe` or `mutate`.
///
/// For subscriptions, use the row type as `R`, not `Vec<R>`. The subscription
/// event already describes the surrounding collection.
///
/// # Errors
///
/// Returns an error if the Chardb reference is malformed.
pub fn operation_schema<A: JsonSchema, R: JsonSchema>(
    reference: impl Into<String>,
) -> Result<OperationSchema> {
    let reference = reference.into();
    validate_reference(&reference)?;
    Ok(OperationSchema {
        reference,
        arguments: schema_for::<A>(),
        result: schema_for::<R>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(JsonSchema)]
    #[allow(dead_code)]
    struct Args {
        organization_id: String,
    }

    #[derive(JsonSchema)]
    #[allow(dead_code)]
    struct Row {
        id: String,
    }

    #[test]
    fn operation_schema_keeps_the_wire_reference_and_real_type_shapes() {
        let schema = operation_schema::<Args, Row>("queries.rs#rows").unwrap();
        let value = serde_json::to_value(schema).unwrap();
        assert_eq!(value["reference"], "queries.rs#rows");
        assert_eq!(
            value["arguments"]["properties"]["organization_id"]["type"],
            "string"
        );
        assert_eq!(value["result"]["properties"]["id"]["type"], "string");
    }
}
