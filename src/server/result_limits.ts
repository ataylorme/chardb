import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";

export const CDB_RESULT_MAX_BYTES = 512 * 1_024;
export const CDB_QUERY_RESULT_MAX_ROWS = 4_096;

/** Check JSON's exact UTF-8 wire size without building a second serialized payload. */
export function assertCdbResultByteLimit(result: RawJson, subject: string, hint: string): void {
    let bytes = 0;
    const add = (amount: number): void => {
        bytes += amount;
        if (bytes > CDB_RESULT_MAX_BYTES) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `${subject} exceeds the ${CDB_RESULT_MAX_BYTES}-byte serialized limit`,
                hint,
            });
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
    const visit = (value: RawJson): void => {
        if (value === null) {
            add(4);
        } else if (typeof value === "string") {
            addString(value);
        } else if (typeof value === "number") {
            add(JSON.stringify(value).length);
        } else if (typeof value === "boolean") {
            add(value ? 4 : 5);
        } else if (Array.isArray(value)) {
            add(2);
            for (let index = 0; index < value.length; index++) {
                if (index > 0) add(1);
                visit(value[index] as RawJson);
            }
        } else {
            add(2);
            let first = true;
            for (const key in value) {
                if (!Object.hasOwn(value, key)) continue;
                if (!first) add(1);
                first = false;
                addString(key);
                add(1);
                visit(value[key] as RawJson);
            }
        }
    };
    visit(result);
}
