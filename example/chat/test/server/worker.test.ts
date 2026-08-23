import { describe, expect, test } from "bun:test";
import { bootstrapDemoSession } from "../../src/server/worker.ts";

interface WhereClause {
    readonly field: string;
    readonly value: unknown;
}

interface AdapterInput {
    readonly model: string;
    readonly where?: readonly WhereClause[];
    readonly data?: Record<string, unknown>;
    readonly update?: Record<string, unknown>;
}

function whereValue(input: AdapterInput, field: string): unknown {
    return input.where?.find(clause => clause.field === field)?.value;
}

describe("chat demo session bootstrap", () => {
    test("reuses one organization and membership across repeated sessions", async () => {
        const organizations = new Map<string, Record<string, unknown>>();
        const memberships = new Map<string, Record<string, unknown>>();
        const activeOrganizations = new Map<string, unknown>();
        const creates: string[] = [];
        const adapter = {
            async findOne<T>(input: AdapterInput): Promise<T | null> {
                if (input.model === "organization") {
                    return (organizations.get(String(whereValue(input, "id"))) as T | undefined) ?? null;
                }
                if (input.model === "member") {
                    const key = `${String(whereValue(input, "organizationId"))}:${String(whereValue(input, "userId"))}`;
                    return (memberships.get(key) as T | undefined) ?? null;
                }
                return null;
            },
            async create(input: AdapterInput): Promise<Record<string, unknown>> {
                const data = input.data ?? {};
                creates.push(input.model);
                if (input.model === "organization") organizations.set(String(data.id), data);
                if (input.model === "member")
                    memberships.set(`${String(data.organizationId)}:${String(data.userId)}`, data);
                return data;
            },
            async update(input: AdapterInput): Promise<Record<string, unknown>> {
                activeOrganizations.set(String(whereValue(input, "id")), input.update?.activeOrganizationId);
                return input.update ?? {};
            },
        };

        await bootstrapDemoSession(adapter as never, { id: "session-1", userId: "user-1" });
        await bootstrapDemoSession(adapter as never, { id: "session-2", userId: "user-1" });

        expect(creates).toEqual(["organization", "member"]);
        expect(organizations).toHaveLength(1);
        expect(memberships).toHaveLength(1);
        expect(activeOrganizations).toEqual(
            new Map([
                ["session-1", "demo-org"],
                ["session-2", "demo-org"],
            ])
        );
    });
});
