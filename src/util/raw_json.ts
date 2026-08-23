import { CdbError, type CdbErrorCode } from "../errors.ts";
import type { RawJson } from "../types.ts";

/** Validate an exact JSON value without coercing unsupported JavaScript data. */
export function rawJsonResult(value: unknown, subject: string, code: CdbErrorCode = "CDB_INVARIANT"): RawJson {
    const active = new WeakSet<object>();

    const fail = (path: string, reason: string): never => {
        throw new CdbError({
            code,
            message: `${subject} is not JSON at ${path}: ${reason}`,
            hint: "return only null, booleans, finite numbers, strings, arrays, and plain objects",
        });
    };

    const visit = (current: unknown, path: string): void => {
        if (current === null || typeof current === "string" || typeof current === "boolean") return;
        if (typeof current === "number") {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                fail(path, "numbers must be finite and must not be negative zero");
            }
            return;
        }
        if (typeof current !== "object") fail(path, `${typeof current} is unsupported`);
        const objectValue = current as object;
        if (active.has(objectValue)) fail(path, "cyclic references are unsupported");
        active.add(objectValue);

        if (Array.isArray(objectValue)) {
            const ownKeys = Reflect.ownKeys(objectValue);
            if (ownKeys.some(key => typeof key === "symbol")) fail(path, "symbol properties are unsupported");
            if (ownKeys.length !== objectValue.length + 1) {
                fail(path, "arrays cannot be sparse or have extra properties");
            }
            for (let index = 0; index < objectValue.length; index++) {
                if (!Object.hasOwn(objectValue, index)) {
                    fail(`${path}[${index}]`, "sparse array entries are unsupported");
                }
                visit(objectValue[index], `${path}[${index}]`);
            }
        } else {
            const prototype = Object.getPrototypeOf(objectValue);
            if (prototype !== Object.prototype && prototype !== null) fail(path, "objects must be plain objects");
            for (const key of Reflect.ownKeys(objectValue)) {
                if (typeof key !== "string") fail(path, "symbol properties are unsupported");
                const stringKey = key as string;
                const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey);
                if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
                    fail(`${path}.${stringKey}`, "properties must be enumerable data properties");
                }
                visit((descriptor as PropertyDescriptor & { value: unknown }).value, `${path}.${stringKey}`);
            }
        }

        active.delete(objectValue);
    };

    visit(value, "$");
    return value as RawJson;
}
