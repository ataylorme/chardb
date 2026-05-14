/** Inputs and outputs of the FK-chain colocation algorithm. */

/** Single FK edge: child table → parent table, on a tuple of columns. */
export interface FkEdge {
    /** Lex-min canonical source: "fk-column" | "relations-one"; for tie-break. */
    readonly source: "fk-column" | "relations-one";
    readonly child: string;
    readonly parent: string;
    /** Ordered tuple of columns on the child that compose this FK. */
    readonly childCols: readonly string[];
    /** Ordered tuple of columns on the parent referenced. */
    readonly parentCols: readonly string[];
}

export interface SchemaInput {
    /** Set of table names. The algorithm is permutation-invariant on this list. */
    readonly tables: readonly string[];
    /** Edges from `build_fk_graph`. Self-loops dropped before SCC. */
    readonly edges: readonly FkEdge[];
}

export type ColocationOverride =
    | { readonly kind: "self" }
    | { readonly kind: "replicated" }
    | { readonly kind: "colocate"; readonly via: string };

export interface PolicyInput {
    /** Default ["organization", "user"]. */
    readonly distributionRoots: readonly string[];
    /** Default true (recommended). */
    readonly strictMultiRoot: boolean;
    /** Default false. */
    readonly requireRoot: boolean;
    /** When true, missing distributionRoots names do not raise. */
    readonly allowMissingRoots: boolean;
    readonly overrides: { readonly [table: string]: ColocationOverride };
}

/**
 * Default colocation policy chardb ships with. Two of the four fields
 * encode opinionated SaaS defaults:
 *
 *   - `distributionRoots: ["organization", "user"]` matches better-auth's
 *     default tenancy model — every multi-tenant app puts org first.
 *   - `strictMultiRoot: false` lets the algorithm auto-resolve a table
 *     that reaches both roots (e.g. `messages` FKs to `organization` and
 *     `user`) via `distributionRoots` priority. Without it every such
 *     table would force the user to write a `policy.overrides[t] = { …
 *     via: "organizationId" }` entry just to silence
 *     `CDB_AMBIGUOUS_COLOCATION`. The strict mode is one-line opt-in
 *     (`policy: { strictMultiRoot: true }`) when the user explicitly
 *     wants every ambiguity to surface as an error.
 */
export const DEFAULT_POLICY: PolicyInput = {
    distributionRoots: ["organization", "user"],
    strictMultiRoot: false,
    requireRoot: false,
    allowMissingRoots: false,
    overrides: {},
};

export type ColocationAssignment =
    | {
          readonly kind: "self";
          /** PK column on this root table. */
          readonly partitionKey: string;
      }
    | { readonly kind: "replicated" }
    | {
          readonly kind: "colocated";
          readonly root: string;
          /** First-edge child columns from the chosen path. */
          readonly via: readonly string[];
      };

export interface ColocationResult {
    readonly assignments: { readonly [table: string]: ColocationAssignment };
    /**
     * Deterministic digest for the partition contract. Hashed over the canonical
     * JSON of `{assignments, edgesUsed, sccs, roots}`.
     */
    readonly digest: string;
}
