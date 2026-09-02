//! Optional JSON Schema descriptions for application argument and result types.

use serde::Serialize;

use crate::Operation;

pub use schemars::{JsonSchema, Schema};

/// The argument and result schemas attached to one CharDB reference.
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
#[must_use]
pub fn operation_schema<O>(operation: O) -> OperationSchema
where
    O: Operation,
    O::Arguments: JsonSchema + Sized,
    O::Output: JsonSchema,
{
    OperationSchema {
        reference: operation.reference().to_owned(),
        arguments: schema_for::<O::Arguments>(),
        result: schema_for::<O::Output>(),
    }
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
        let schema = operation_schema(crate::Query::<Args, Row>::new("queries.rs#rows"));
        let value = serde_json::to_value(schema).unwrap();
        assert_eq!(value["reference"], "queries.rs#rows");
        assert_eq!(
            value["arguments"]["properties"]["organization_id"]["type"],
            "string"
        );
        assert_eq!(value["result"]["properties"]["id"]["type"], "string");
    }
}
