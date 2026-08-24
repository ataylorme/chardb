import { CdbError, type CdbErrorCode } from "../errors.ts";
import type { RawJson } from "../types.ts";

const MAX_ARGUMENT_MEMBERS = 4_096;
const MAX_ARGUMENT_BYTES = 512 * 1_024;
const MAX_ARGUMENT_DEPTH = 99;

export interface SerializedJsonLimits {
    readonly memberLimit?: number;
    readonly maxDepth?: number;
    readonly errorCode?: CdbErrorCode;
}

function inspectSerializedJson(
    value: unknown,
    limit: number,
    subject: string,
    limits: SerializedJsonLimits,
    copy: boolean
): { readonly bytes: number; readonly owned?: RawJson } {
    const errorCode = limits.errorCode ?? "CDB_INVARIANT";
    let bytes = 0;
    let members = 0;
    const ancestors = new WeakSet<object>();
    const invalidJson = (reason: string): never => {
        throw new CdbError({ code: errorCode, message: `${subject} is not JSON-compatible: ${reason}` });
    };
    const add = (amount: number): void => {
        bytes += amount;
        if (bytes > limit) {
            throw new CdbError({ code: errorCode, message: `${subject} exceeds the ${limit}-byte client limit` });
        }
    };
    const addMember = (): void => {
        members++;
        if (limits.memberLimit !== undefined && members > limits.memberLimit) {
            throw new CdbError({
                code: errorCode,
                message: `${subject} exceeds the ${limits.memberLimit}-member client limit`,
            });
        }
    };
    const visitChild = (child: unknown, depth: number): RawJson | undefined => {
        addMember();
        if (limits.maxDepth !== undefined && depth >= limits.maxDepth) {
            throw new CdbError({
                code: errorCode,
                message: `${subject} exceeds the ${limits.maxDepth}-level client depth limit`,
            });
        }
        return visit(child, depth + 1);
    };
    const addString = (text: string): void => {
        add(2);
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
                add(2);
            } else if (code <= 31) {
                add(6);
            } else if (code <= 127) {
                add(1);
            } else if (code <= 2_047) {
                add(2);
            } else if (code >= 55_296 && code <= 56_319) {
                const next = text.charCodeAt(index + 1);
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
    const visit = (item: unknown, depth: number): RawJson | undefined => {
        if (item === null) {
            add(4);
            return copy ? null : undefined;
        }
        if (typeof item === "string") {
            addString(item);
            return copy ? item : undefined;
        }
        if (typeof item === "number") {
            if (!Number.isFinite(item) || Object.is(item, -0)) {
                invalidJson("numbers must be finite and must not be negative zero");
            }
            add(JSON.stringify(item).length);
            return copy ? item : undefined;
        }
        if (typeof item === "boolean") {
            add(item ? 4 : 5);
            return copy ? item : undefined;
        }
        if (typeof item !== "object") return invalidJson(`${typeof item} values are unsupported`);

        if (limits.maxDepth !== undefined && depth >= limits.maxDepth) {
            throw new CdbError({
                code: errorCode,
                message: `${subject} exceeds the ${limits.maxDepth}-level client depth limit`,
            });
        }

        if (ancestors.has(item)) invalidJson("cyclic references are unsupported");
        ancestors.add(item);
        if (Array.isArray(item)) {
            const ownKeys = Reflect.ownKeys(item);
            if (ownKeys.some(key => typeof key === "symbol")) invalidJson("symbol properties are unsupported");
            const lengthDescriptor = Object.getOwnPropertyDescriptor(item, "length");
            if (!lengthDescriptor || !("value" in lengthDescriptor)) {
                return invalidJson("arrays must have an own data length");
            }
            const length = lengthDescriptor.value;
            if (!Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1) {
                invalidJson("arrays cannot be sparse or have extra properties");
            }
            const owned: RawJson[] | undefined = copy ? [] : undefined;
            add(2);
            for (let index = 0; index < length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                if (!descriptor) invalidJson("array entries must be own properties");
                const dataDescriptor = descriptor as PropertyDescriptor;
                if (!dataDescriptor.enumerable || !("value" in dataDescriptor)) {
                    invalidJson("array entries must be enumerable data properties");
                }
                if (index > 0) add(1);
                const child = visitChild(dataDescriptor.value, depth);
                if (owned) owned.push(child as RawJson);
            }
            ancestors.delete(item);
            return owned;
        }

        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) invalidJson("objects must be plain objects");
        const owned: Record<string, RawJson> | undefined = copy
            ? prototype === null
                ? Object.create(null)
                : {}
            : undefined;
        add(2);
        let first = true;
        for (const key of Reflect.ownKeys(item)) {
            if (typeof key !== "string") invalidJson("symbol properties are unsupported");
            const stringKey = key as string;
            const descriptor = Object.getOwnPropertyDescriptor(item, stringKey);
            if (!descriptor) invalidJson("object properties must be own properties");
            const dataDescriptor = descriptor as PropertyDescriptor;
            if (!dataDescriptor.enumerable || !("value" in dataDescriptor)) {
                invalidJson("object properties must be enumerable data properties");
            }
            if (!first) add(1);
            first = false;
            addString(stringKey);
            add(1);
            const child = visitChild(dataDescriptor.value, depth);
            if (owned) {
                Object.defineProperty(owned, stringKey, {
                    value: child,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        }
        ancestors.delete(item);
        return owned;
    };
    const owned = visit(value, 0);
    return copy ? { bytes, owned: owned as RawJson } : { bytes };
}

export function assertSerializedSize(
    value: unknown,
    limit: number,
    subject: string,
    limits: SerializedJsonLimits = {}
): number {
    return inspectSerializedJson(value, limit, subject, limits, false).bytes;
}

function snapshotSerializedJson(value: unknown, limit: number, subject: string, limits: SerializedJsonLimits): RawJson {
    return inspectSerializedJson(value, limit, subject, limits, true).owned as RawJson;
}

export function snapshotMutationArguments(args: RawJson): RawJson {
    return snapshotSerializedJson(args, MAX_ARGUMENT_BYTES, "mutation arguments", {
        memberLimit: MAX_ARGUMENT_MEMBERS,
        maxDepth: MAX_ARGUMENT_DEPTH,
        errorCode: "CDB_INVALID_ARGS",
    });
}

export function snapshotSubscriptionArguments(args: RawJson): RawJson {
    return snapshotSerializedJson(args, MAX_ARGUMENT_BYTES, "subscription arguments", {
        memberLimit: MAX_ARGUMENT_MEMBERS,
        maxDepth: MAX_ARGUMENT_DEPTH,
        errorCode: "CDB_INVALID_ARGS",
    });
}
