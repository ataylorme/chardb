/**
 * Deterministic FK-chain colocation inference.
 *
 * The algorithm is a pure function of the schema. Two schemas that differ
 * only in `Object.keys` iteration order (or in adding an unrelated table)
 * produce identical assignments and digests; the test suite in
 * `test/colocation/` enforces every invariant.
 *
 *   1. Drop self-loops; canonicalize parallel edges (sort + dedupe).
 *   2. Tarjan SCCs over the directed FK graph; iterate child→parent edges.
 *   3. Condense to a DAG; compute reachability to `policy.distributionRoots`.
 *   4. For each table, in lex order:
 *        - explicit `policy.overrides[T]` → apply
 *        - SCC contains a root → SELF (partition key = `id`)
 *        - 0 reached roots → strict raise `CDB_AMBIGUOUS_COLOCATION`,
 *                            else REPLICATED reference table
 *        - 1 reached root  → COLOCATED via the lex-min path's first-edge
 *                            column tuple
 *        - >1 reached root → strict raise; non-strict picks the first matching
 *                            root in `distributionRoots` priority order
 *   5. SCC `via` coherence: every table in an SCC must agree on (root, via);
 *      otherwise raise.
 *
 * Tarjan's SCC pseudocode and the priority-list-with-strict-mode pattern are
 * widely documented; useful references include Citus colocation groups
 * (https://docs.citusdata.com/en/stable/develop/reference_ddl.html#colocating-tables)
 * and the CockroachDB interleaved-tables RFCs
 * (https://github.com/cockroachdb/cockroach/blob/master/docs/RFCS/20160624_sql_interleaved_tables.md).
 */

import { CdbError } from "../errors.ts";
import { stableHashHex, stableJson } from "../util/canonical.ts";
import {
    type ColocationAssignment,
    type ColocationResult,
    DEFAULT_POLICY,
    type FkEdge,
    type PolicyInput,
    type SchemaInput,
} from "./types.ts";

/** Lex-compare arrays of strings. */
function cmpStringArr(a: readonly string[], b: readonly string[]): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const ai = a[i] as string;
        const bi = b[i] as string;
        if (ai < bi) return -1;
        if (ai > bi) return 1;
    }
    return a.length - b.length;
}

/** Lex-compare two FK edges so parallel edges canonicalize identically. */
function cmpEdge(a: FkEdge, b: FkEdge): number {
    if (a.child !== b.child) return a.child < b.child ? -1 : 1;
    if (a.parent !== b.parent) return a.parent < b.parent ? -1 : 1;
    const c1 = cmpStringArr(a.childCols, b.childCols);
    if (c1 !== 0) return c1;
    const c2 = cmpStringArr(a.parentCols, b.parentCols);
    if (c2 !== 0) return c2;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

/** Canonicalize edges: drop self-loops, dedupe duplicates, sort. */
function canonicalizeEdges(edges: readonly FkEdge[]): FkEdge[] {
    const filtered: FkEdge[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
        if (e.child === e.parent) continue; // self-loops dropped
        const key = `${e.child}|${e.parent}|${e.childCols.join(",")}|${e.parentCols.join(",")}|${e.source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        filtered.push({ ...e, childCols: [...e.childCols], parentCols: [...e.parentCols] });
    }
    filtered.sort(cmpEdge);
    return filtered;
}

/** Tarjan SCC. Iteration order pinned by sorted adjacency lists for determinism. */
function tarjanScc(nodes: readonly string[], edges: readonly FkEdge[]): readonly (readonly string[])[] {
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n, []);
    for (const e of edges) {
        const arr = adj.get(e.child);
        if (arr) arr.push(e.parent);
    }
    for (const arr of adj.values()) arr.sort();

    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const sccs: string[][] = [];

    const iterative = (start: string) => {
        type Frame = { v: string; iter: number };
        const stk: Frame[] = [{ v: start, iter: 0 }];
        idx.set(start, index);
        low.set(start, index);
        index++;
        stack.push(start);
        onStack.add(start);
        while (stk.length > 0) {
            const f = stk[stk.length - 1] as Frame;
            const succs = adj.get(f.v) ?? [];
            if (f.iter < succs.length) {
                const w = succs[f.iter] as string;
                f.iter++;
                if (!idx.has(w)) {
                    idx.set(w, index);
                    low.set(w, index);
                    index++;
                    stack.push(w);
                    onStack.add(w);
                    stk.push({ v: w, iter: 0 });
                } else if (onStack.has(w)) {
                    low.set(f.v, Math.min(low.get(f.v) as number, idx.get(w) as number));
                }
            } else {
                if ((low.get(f.v) as number) === (idx.get(f.v) as number)) {
                    const comp: string[] = [];
                    while (true) {
                        const w = stack.pop() as string;
                        onStack.delete(w);
                        comp.push(w);
                        if (w === f.v) break;
                    }
                    comp.sort();
                    sccs.push(comp);
                }
                stk.pop();
                if (stk.length > 0) {
                    const parent = stk[stk.length - 1] as Frame;
                    low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(f.v) as number));
                }
            }
        }
    };

    for (const n of [...nodes].sort()) if (!idx.has(n)) iterative(n);
    sccs.sort((a, b) => {
        const ai = a[0] as string;
        const bi = b[0] as string;
        return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    return sccs;
}

/** Condense to a DAG. */
function condense(
    sccs: readonly (readonly string[])[],
    edges: readonly FkEdge[]
): {
    readonly sccIdOf: ReadonlyMap<string, number>;
    readonly dagAdj: ReadonlyMap<number, ReadonlySet<number>>;
} {
    const sccIdOf = new Map<string, number>();
    for (let i = 0; i < sccs.length; i++) {
        for (const t of sccs[i] as readonly string[]) sccIdOf.set(t, i);
    }
    const dagAdj = new Map<number, Set<number>>();
    for (let i = 0; i < sccs.length; i++) dagAdj.set(i, new Set<number>());
    for (const e of edges) {
        const a = sccIdOf.get(e.child);
        const b = sccIdOf.get(e.parent);
        if (a === undefined || b === undefined || a === b) continue;
        (dagAdj.get(a) as Set<number>).add(b);
    }
    return { sccIdOf, dagAdj };
}

/** All simple paths from `src` to any of `targets` in the condensed DAG. */
function allSimplePaths(
    dagAdj: ReadonlyMap<number, ReadonlySet<number>>,
    src: number,
    targets: ReadonlySet<number>
): readonly (readonly number[])[] {
    const out: number[][] = [];
    const visited = new Set<number>();
    const path: number[] = [src];
    visited.add(src);
    const dfs = (cur: number) => {
        if (targets.has(cur)) {
            out.push([...path]);
            return;
        }
        for (const next of [...(dagAdj.get(cur) ?? [])].sort((a, b) => a - b)) {
            if (visited.has(next)) continue;
            visited.add(next);
            path.push(next);
            dfs(next);
            path.pop();
            visited.delete(next);
        }
    };
    if (targets.has(src)) out.push([src]);
    else dfs(src);
    return out;
}

/**
 * Find all child→parent edges crossing from `srcScc` to `dstScc`. Returns
 * the lex-min edge — used to choose `first_edge_key` for the path.
 */
function pickEdge(srcScc: readonly string[], dstScc: readonly string[], edges: readonly FkEdge[]): FkEdge {
    const srcSet = new Set(srcScc);
    const dstSet = new Set(dstScc);
    let best: FkEdge | null = null;
    for (const e of edges) {
        if (srcSet.has(e.child) && dstSet.has(e.parent)) {
            if (best === null || cmpEdge(e, best) < 0) best = e;
        }
    }
    if (best === null) throw new Error(`no edge from ${srcScc[0]} to ${dstScc[0]} (corrupt DAG)`);
    return best;
}

interface PathChoice {
    readonly path: readonly number[];
    readonly firstEdge: FkEdge;
    readonly fullEdges: readonly FkEdge[];
}

function chooseBestPath(
    paths: readonly (readonly number[])[],
    sccs: readonly (readonly string[])[],
    edges: readonly FkEdge[]
): PathChoice {
    const choices: PathChoice[] = paths.map(p => {
        const fullEdges: FkEdge[] = [];
        for (let i = 0; i + 1 < p.length; i++) {
            const a = sccs[p[i] as number] as readonly string[];
            const b = sccs[p[i + 1] as number] as readonly string[];
            fullEdges.push(pickEdge(a, b, edges));
        }
        const firstEdge = fullEdges[0];
        if (!firstEdge) {
            throw new Error("path has no edges (single-node path should be intercepted by caller)");
        }
        return { path: p, firstEdge, fullEdges };
    });
    // Tie-break order: (path-length, edge-key-arity, edge-key-column-tuple-lex,
    // full-edge-sequence-lex). source field is included via cmpEdge.
    choices.sort((a, b) => {
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        if (a.firstEdge.childCols.length !== b.firstEdge.childCols.length) {
            return a.firstEdge.childCols.length - b.firstEdge.childCols.length;
        }
        const c1 = cmpStringArr(a.firstEdge.childCols, b.firstEdge.childCols);
        if (c1 !== 0) return c1;
        for (let i = 0; i < Math.min(a.fullEdges.length, b.fullEdges.length); i++) {
            const ce = cmpEdge(a.fullEdges[i] as FkEdge, b.fullEdges[i] as FkEdge);
            if (ce !== 0) return ce;
        }
        return 0;
    });
    return choices[0] as PathChoice;
}

export function deriveColocation(schema: SchemaInput, policyIn: Partial<PolicyInput> = {}): ColocationResult {
    const policy: PolicyInput = { ...DEFAULT_POLICY, ...policyIn };
    const tables = [...new Set(schema.tables)].sort();
    const edges = canonicalizeEdges(schema.edges);

    if (!policy.allowMissingRoots) {
        for (const r of policy.distributionRoots) {
            if (!tables.includes(r)) {
                throw new CdbError({
                    code: "CDB_POLICY_UNKNOWN_ROOT",
                    message: `policy.distributionRoots references unknown table "${r}"`,
                    hint: "check spelling/case, or set policy.allowMissingRoots=true for forward-compat placeholders",
                });
            }
        }
    }

    const sccs = tarjanScc(tables, edges);
    const { sccIdOf, dagAdj } = condense(sccs, edges);
    const rootSccs = new Set<number>();
    for (const r of policy.distributionRoots) {
        const id = sccIdOf.get(r);
        if (id !== undefined) rootSccs.add(id);
    }

    const assignments: { [table: string]: ColocationAssignment } = {};

    for (const t of tables) {
        const override = policy.overrides[t];
        if (override) {
            if (override.kind === "self") assignments[t] = { kind: "self", partitionKey: "id" };
            else if (override.kind === "replicated") assignments[t] = { kind: "replicated" };
            else {
                // `via` accepts a single column name (the common case) OR a
                // tuple for composite-FK colocation. The assignment shape
                // always normalizes to a tuple so consumers don't have to
                // branch on input arity.
                const viaTuple: readonly string[] = Array.isArray(override.via)
                    ? (override.via as readonly string[])
                    : [override.via as string];
                assignments[t] = { kind: "colocated", root: t, via: viaTuple };
            }
            continue;
        }

        const sccId = sccIdOf.get(t) as number;
        if (rootSccs.has(sccId)) {
            // Table itself is a distribution root (or in an SCC with one).
            const rootName = (policy.distributionRoots.find(r => sccIdOf.get(r) === sccId) ?? t) as string;
            assignments[t] = { kind: "self", partitionKey: t === rootName ? "id" : "id" };
            continue;
        }

        const paths = allSimplePaths(dagAdj, sccId, rootSccs);
        const reachedRoots = new Set<number>();
        for (const p of paths) reachedRoots.add(p[p.length - 1] as number);

        if (reachedRoots.size === 0) {
            if (policy.requireRoot) {
                throw new CdbError({
                    code: "CDB_AMBIGUOUS_COLOCATION",
                    message: `table "${t}" has no FK path to any of [${policy.distributionRoots.join(", ")}]`,
                    hint: `add \`.partitionedBy('replicated')\` or \`.partitionedBy('self')\` on ${t}`,
                });
            }
            assignments[t] = { kind: "replicated" };
            continue;
        }

        let chosenRootScc: number;
        if (reachedRoots.size === 1) {
            chosenRootScc = [...reachedRoots][0] as number;
        } else if (policy.strictMultiRoot) {
            const candidateText = [...reachedRoots]
                .map(r => {
                    const rootName = (sccs[r] as readonly string[])[0] as string;
                    const pathsToR = paths.filter(p => p[p.length - 1] === r);
                    const best = chooseBestPath(pathsToR, sccs, edges);
                    return `${rootName} via ${best.firstEdge.childCols.join(",")}`;
                })
                .sort()
                .join(", ");
            throw new CdbError({
                code: "CDB_AMBIGUOUS_COLOCATION",
                message: `table "${t}" has FK paths to multiple distribution roots: ${candidateText}`,
                hint: `add \`.partitionedBy('colocate', { via: '<col>' })\` on ${t}`,
            });
        } else {
            chosenRootScc = (() => {
                for (const r of policy.distributionRoots) {
                    const id = sccIdOf.get(r);
                    if (id !== undefined && reachedRoots.has(id)) return id;
                }
                // unreachable given reachedRoots.size>0 and intersection nonempty
                return [...reachedRoots][0] as number;
            })();
        }

        const pathsToRoot = paths.filter(p => p[p.length - 1] === chosenRootScc);
        const choice = chooseBestPath(pathsToRoot, sccs, edges);
        const rootName = (sccs[chosenRootScc] as readonly string[])[0] as string;
        assignments[t] = { kind: "colocated", root: rootName, via: choice.firstEdge.childCols };
    }

    // SCC `via` coherence: every SCC of size > 1 must agree on (root, via);
    // mismatches surface as `CDB_AMBIGUOUS_COLOCATION` so users can split the
    // cycle or annotate `.partitionedBy(...)` per member.
    for (const scc of sccs) {
        if (scc.length <= 1) continue;
        const seen = new Set<string>();
        for (const t of scc) {
            const a = assignments[t];
            if (!a) continue;
            const fp =
                a.kind === "colocated"
                    ? `colocated:${a.root}:${a.via.join(",")}`
                    : a.kind === "self"
                      ? `self:${a.partitionKey}`
                      : `replicated`;
            seen.add(fp);
        }
        if (seen.size > 1) {
            throw new CdbError({
                code: "CDB_AMBIGUOUS_COLOCATION",
                message: `SCC {${scc.join(", ")}} requires inconsistent colocation: ${[...seen].sort().join(" / ")}`,
                hint: "split the cycle or add explicit `.partitionedBy(...)` on each member",
            });
        }
        // Normalize: pick lex-min `via` across members for output stability.
        const colocated = Object.values(assignments).find(a => a.kind === "colocated") as
            | ColocationAssignment
            | undefined;
        if (colocated && colocated.kind === "colocated") {
            for (const t of scc) {
                const a = assignments[t];
                if (a && a.kind === "colocated") {
                    assignments[t] = { kind: "colocated", root: colocated.root, via: colocated.via };
                }
            }
        }
    }

    const digest = stableHashHex({
        assignments,
        edges,
        sccs,
        roots: policy.distributionRoots,
        requireRoot: policy.requireRoot,
        strictMultiRoot: policy.strictMultiRoot,
    });

    return { assignments, digest };
}

export { stableJson };
