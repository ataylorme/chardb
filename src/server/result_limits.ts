import { CdbError, type CdbErrorCode } from "../errors.ts";
import type { RawJson } from "../types.ts";

export const CDB_RESULT_MAX_BYTES = 512 * 1_024;
export const CDB_QUERY_RESULT_MAX_ROWS = 4_096;
export const CDB_MUTATION_ARGS_MAX_BYTES = 512 * 1_024;
export const CDB_JSON_MAX_AGGREGATE_MEMBERS = 4_096;
export const CDB_MUTATION_ARGS_MAX_DEPTH = 99;

/** Check exact JSON UTF-8 size and structure without building a second serialized payload. */
export function assertCdbJsonByteLimit(
    value: RawJson,
    maxBytes: number,
    error: { readonly code: CdbErrorCode; readonly subject: string; readonly hint: string },
    structure?: { readonly maxAggregateMembers: number; readonly maxDepth: number }
): void {
    let bytes = 0;
    let members = 0;
    const fail = (message: string): never => {
        throw new CdbError({ code: error.code, message, hint: error.hint });
    };
    const add = (amount: number): void => {
        bytes += amount;
        if (bytes > maxBytes) {
            fail(`${error.subject} exceeds the ${maxBytes}-byte serialized limit`);
        }
    };
    const addString = (value: string): void => {
        add(2);
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
                add(2);
            } else if (code <= 31) {
                add(6);
            } else if (code <= 127) {
                add(1);
            } else if (code <= 2_047) {
                add(2);
            } else if (code >= 55_296 && code <= 56_319) {
                const next = value.charCodeAt(index + 1);
                if (next >= 56_320 && next <= 57_343) {
                    add(4);
                    index++;
                } else {
                    add(6);
                }
            } else if (code >= 56_320 && code <= 57_343) {
                add(6);
            } else {
                add(3);
            }
        }
    };
    const dataProperty = (object: object, key: PropertyKey): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            fail(`${error.subject} is not JSON-compatible`);
        }
        return (descriptor as PropertyDescriptor & { readonly value: unknown }).value;
    };
    type Frame =
        | { readonly kind: "value"; readonly value: unknown; readonly depth: number }
        | { readonly kind: "exit"; readonly value: object };
    const ancestors = new WeakSet<object>();
    const stack: Frame[] = [{ kind: "value", value, depth: 0 }];
    while (stack.length > 0) {
        const frame = stack.pop() as Frame;
        if (frame.kind === "exit") {
            ancestors.delete(frame.value);
            continue;
        }
        const item = frame.value;
        if (item === null) {
            add(4);
        } else if (typeof item === "string") {
            addString(item);
        } else if (typeof item === "number") {
            if (!Number.isFinite(item) || Object.is(item, -0)) {
                fail(`${error.subject} is not JSON-compatible`);
            }
            add(JSON.stringify(item).length);
        } else if (typeof item === "boolean") {
            add(item ? 4 : 5);
        } else if (typeof item === "object") {
            const depth = frame.depth + 1;
            if (structure && depth > structure.maxDepth) {
                fail(`${error.subject} exceeds the ${structure.maxDepth}-level nesting limit`);
            }
            if (ancestors.has(item)) fail(`${error.subject} is not JSON-compatible`);
            ancestors.add(item);
            stack.push({ kind: "exit", value: item });
            if (Array.isArray(item)) {
                const ownKeys = Reflect.ownKeys(item);
                if (ownKeys.some(key => typeof key === "symbol") || ownKeys.length !== item.length + 1) {
                    fail(`${error.subject} is not JSON-compatible`);
                }
                members += item.length;
                if (structure && members > structure.maxAggregateMembers) {
                    fail(`${error.subject} exceeds the ${structure.maxAggregateMembers}-member aggregate limit`);
                }
                add(2 + Math.max(0, item.length - 1));
                for (let index = item.length - 1; index >= 0; index--) {
                    stack.push({ kind: "value", value: dataProperty(item, String(index)), depth });
                }
                continue;
            }
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null) {
                fail(`${error.subject} is not JSON-compatible`);
            }
            const ownKeys = Reflect.ownKeys(item);
            if (ownKeys.some(key => typeof key === "symbol")) fail(`${error.subject} is not JSON-compatible`);
            const entries = ownKeys.map(key => {
                const stringKey = key as string;
                return [stringKey, dataProperty(item, stringKey)] as const;
            });
            const keys = entries.map(([key]) => key);
            members += keys.length;
            if (structure && members > structure.maxAggregateMembers) {
                fail(`${error.subject} exceeds the ${structure.maxAggregateMembers}-member aggregate limit`);
            }
            add(2);
            for (let index = 0; index < keys.length; index++) {
                if (index > 0) add(1);
                addString(keys[index] as string);
                add(1);
            }
            for (let index = entries.length - 1; index >= 0; index--) {
                stack.push({ kind: "value", value: (entries[index] as readonly [string, unknown])[1], depth });
            }
        } else {
            fail(`${error.subject} is not JSON-compatible`);
        }
    }
}

export function assertCdbResultByteLimit(result: RawJson, subject: string, hint: string): void {
    assertCdbJsonByteLimit(result, CDB_RESULT_MAX_BYTES, { code: "CDB_INVARIANT", subject, hint });
}

export function assertCdbMutationArgsByteLimit(args: RawJson): void {
    assertCdbJsonByteLimit(
        args,
        CDB_MUTATION_ARGS_MAX_BYTES,
        {
            code: "CDB_INVALID_ARGS",
            subject: "mutation argument payload",
            hint: `Reduce mutation arguments to at most ${CDB_MUTATION_ARGS_MAX_BYTES} serialized bytes.`,
        },
        {
            maxAggregateMembers: CDB_JSON_MAX_AGGREGATE_MEMBERS,
            maxDepth: CDB_MUTATION_ARGS_MAX_DEPTH,
        }
    );
}
