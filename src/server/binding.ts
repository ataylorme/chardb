import { WorkerEntrypoint } from "cloudflare:workers";
import type {
    ChardbBindingMutationRequest,
    ChardbBindingMutationResponse,
    ChardbBindingQueryRequest,
    ChardbBindingQueryResponse,
} from "../binding.ts";
import { CdbError } from "../errors.ts";
import { ClientId, type PrincipalId } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import { cdbPolicyDigest } from "./cdb-policy.ts";
import {
    type GatewayJwtConfig,
    type TrustedMutationDispatchDeps,
    type TrustedQueryDispatchDeps,
    dispatchTrustedMutation,
    dispatchTrustedQuery,
    isCurrentVerifiedAttachment,
    verifyGatewayJwt,
} from "./do/gateway.ts";
import { withChardbLoopbacks } from "./loopback.ts";
import { type ChardbManifest, emptyManifest, routeMutation, routeQuery } from "./manifest.ts";
import type { CatalogMutationRpc, CatalogOrganizationAuthorityRpc, CdbMutationRpc, CdbQueryRpc } from "./rpc.ts";

export interface DbBindingEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

export interface DbBindingRuntimeConfig {
    readonly schema: () => Record<string, unknown>;
    readonly manifest: () => ChardbManifest;
    readonly auth: GatewayJwtConfig | null;
}

const DB_BINDING_JWT_MAX_BYTES = 16 * 1_024;
const DB_BINDING_ID_MAX_BYTES = 256;
const DB_BINDING_REF_MAX_BYTES = 1_024;
const TEXT_ENCODER = new TextEncoder();

function failure(code: ConstructorParameters<typeof CdbError>[0]["code"], message: string) {
    return { ok: false as const, error: new CdbError({ code, message }).toJSON() };
}

function boundedText(value: unknown, maxBytes: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        TEXT_ENCODER.encode(value).byteLength <= maxBytes &&
        !Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 31 || code === 127;
        })
    );
}

function validOrigin(value: unknown): value is string {
    if (!boundedText(value, 2_048)) return false;
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            parsed.origin === value &&
            parsed.username === "" &&
            parsed.password === ""
        );
    } catch {
        return false;
    }
}

/** Native same-Worker RPC entrypoint exposed as the application's `env.DB`. */
export class DB extends WorkerEntrypoint<DbBindingEnv> {
    constructor(ctx: ExecutionContext, env: DbBindingEnv) {
        super(ctx, withChardbLoopbacks(env, ctx));
    }

    protected runtimeSchema(): Record<string, unknown> {
        return {};
    }

    protected runtimeManifest(): ChardbManifest {
        return emptyManifest();
    }

    protected jwtConfig(): GatewayJwtConfig | null {
        return null;
    }

    async executeQuery(request: ChardbBindingQueryRequest): Promise<ChardbBindingQueryResponse> {
        const validated = this.validateRequest(request);
        if (!validated.ok) return validated;
        const principalId = await this.verifyPrincipal(request);
        if (!principalId.ok) return principalId;
        const deps: TrustedQueryDispatchDeps = {
            routeQuery: input =>
                routeQuery(this.runtimeManifest(), input, tables => cdbPolicyDigest(this.runtimeSchema(), tables)),
            catalog: this.catalog(),
            cdb: shardId => this.cdb(shardId),
        };
        return dispatchTrustedQuery(deps, { principalId: principalId.value, ref: request.ref, args: request.args });
    }

    async executeMutation(request: ChardbBindingMutationRequest): Promise<ChardbBindingMutationResponse> {
        const validated = this.validateRequest(request);
        if (!validated.ok) return validated;
        if (!boundedText(request.mutId, DB_BINDING_ID_MAX_BYTES)) {
            return failure("CDB_INVALID_ARGS", "DB binding mutation id is invalid");
        }
        const principalId = await this.verifyPrincipal(request);
        if (!principalId.ok) return principalId;
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: input => routeMutation(this.runtimeManifest(), input, vshardOf),
            catalog: this.catalog(),
            cdb: shardId => this.cdb(shardId),
        };
        return dispatchTrustedMutation(deps, {
            principalId: principalId.value,
            mutId: request.mutId,
            ref: request.ref,
            args: request.args,
        });
    }

    private validateRequest(request: ChardbBindingQueryRequest): { readonly ok: true } | ReturnType<typeof failure> {
        if (typeof request !== "object" || request === null || Array.isArray(request)) {
            return failure("CDB_INVALID_ARGS", "DB binding request is malformed");
        }
        if (!boundedText(request.jwt, DB_BINDING_JWT_MAX_BYTES)) {
            return failure("CDB_FORBIDDEN", "DB binding JWT is missing or invalid");
        }
        if (!validOrigin(request.authOrigin)) {
            return failure("CDB_INVALID_ARGS", "DB binding auth origin must be an exact HTTP origin");
        }
        if (!boundedText(request.ref, DB_BINDING_REF_MAX_BYTES) || !request.ref.includes("#")) {
            return failure("CDB_INVALID_ARGS", "DB binding ref is invalid");
        }
        return { ok: true };
    }

    private async verifyPrincipal(
        request: ChardbBindingQueryRequest
    ): Promise<{ readonly ok: true; readonly value: PrincipalId } | ReturnType<typeof failure>> {
        const config = this.jwtConfig();
        if (!config) return failure("CDB_AUTH_NOT_BOUND", "DB binding requires the Better Auth JWT plugin");
        try {
            const attachment = await verifyGatewayJwt({
                config,
                authOrigin: request.authOrigin,
                catalog: this.catalog(),
                jwt: request.jwt,
                connectionId: crypto.randomUUID(),
                clientId: ClientId("db-binding"),
            });
            if (!isCurrentVerifiedAttachment(attachment)) {
                return failure("CDB_FORBIDDEN", "DB binding JWT is expired or not active");
            }
            return { ok: true, value: attachment.principalId };
        } catch (error) {
            if (error instanceof CdbError) return { ok: false, error: error.toJSON() };
            return failure("CDB_FORBIDDEN", "DB binding JWT verification failed");
        }
    }

    private catalog(): CatalogMutationRpc &
        CatalogOrganizationAuthorityRpc &
        Parameters<typeof verifyGatewayJwt>[0]["catalog"] {
        const id = this.env.CDB_CATALOG.idFromName("global");
        return this.env.CDB_CATALOG.get(id) as unknown as CatalogMutationRpc &
            CatalogOrganizationAuthorityRpc &
            Parameters<typeof verifyGatewayJwt>[0]["catalog"];
    }

    private cdb(shardId: string): CdbMutationRpc & CdbQueryRpc {
        const id = this.env.CDB_SHARD.idFromName(shardId);
        return this.env.CDB_SHARD.get(id) as unknown as CdbMutationRpc & CdbQueryRpc;
    }
}

/** Bind the app's schema, stable-ref manifest, and JWT verifier into `DB`. */
export function configureDbBindingRuntime(config: DbBindingRuntimeConfig): typeof DB {
    return class ConfiguredDB extends DB {
        protected override runtimeSchema(): Record<string, unknown> {
            return config.schema();
        }

        protected override runtimeManifest(): ChardbManifest {
            return config.manifest();
        }

        protected override jwtConfig(): GatewayJwtConfig | null {
            return config.auth;
        }
    };
}
