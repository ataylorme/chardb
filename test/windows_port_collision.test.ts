import { describe, expect, test } from "bun:test";
import { isOccupiedPortFailure } from "./helpers/windows-port-collision.ts";

describe("Windows dev-tree occupied-port output", () => {
    test("accepts POSIX and EADDRINUSE output", () => {
        expect(isOccupiedPortFailure("listen EADDRINUSE: address already in use 127.0.0.1:8787", 8787)).toBe(true);
    });

    test("accepts Workerd's Windows socket error", () => {
        const output =
            "failed to bind 127.0.0.1:8787: #10013 An attempt was made to access a socket in a way forbidden by its access permissions";
        expect(isOccupiedPortFailure(output, 8787)).toBe(true);
    });

    test("rejects an occupied-port error for another port", () => {
        expect(isOccupiedPortFailure("listen EADDRINUSE: address already in use 127.0.0.1:18787", 8787)).toBe(false);
    });

    test("rejects an unrelated failure that mentions the port", () => {
        expect(isOccupiedPortFailure("could not load wrangler.toml for http://127.0.0.1:8787", 8787)).toBe(false);
    });
});
