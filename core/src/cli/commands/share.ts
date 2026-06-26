import { Effect, Schema, type Scope } from "effect";

import { TunnelProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  TunnelSession,
  type TunnelSession as TunnelSessionType,
  TunnelStatus,
  type TunnelStatus as TunnelStatusType,
  type TunnelTarget as TunnelTargetType,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type TunnelError,
  TunnelService,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofileAt } from "../app-resolution.ts";
import type { RenderContext } from "../renderer-boundary.ts";

export const ShareStopResultSchema = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.optional(Schema.String),
  status: TunnelStatus,
});
export type ShareStopResult = typeof ShareStopResultSchema.Type;

export const ShareListResultSchema = Schema.Array(TunnelSession);

export interface ShareOptions {
  readonly cwd?: string;
  readonly target?: TunnelTargetType;
  readonly provider?: string;
  readonly detach?: boolean;
  readonly yes?: boolean;
  readonly format?: "text" | "json";
}

export interface ShareListOptions {
  readonly cwd?: string;
  readonly provider?: string;
  readonly format?: "text" | "json";
}

export interface ShareStopOptions extends ShareListOptions {
  readonly sessionId: string;
  readonly force?: boolean;
}

type ShareServices = LandofileService | RuntimeProviderRegistry | AppPlanner;

const unavailable = (requested?: string): TunnelProviderUnavailableError =>
  new TunnelProviderUnavailableError({
    message:
      requested === undefined
        ? "No TunnelService is installed."
        : `No TunnelService is installed for ${requested}.`,
    ...(requested === undefined ? {} : { provider: requested }),
    installOptions: [
      "lando plugin:add <tunnel-service-plugin>",
      "lando setup --provider=<provider-with-tunnels>",
    ],
    remediation:
      "Install a TunnelService plugin, then rerun the command. Bundled tunnel connectors ship in Lando 4.1.",
  });

const resolveTunnelService = (requested?: string) =>
  Effect.gen(function* () {
    const serviceOption = yield* Effect.serviceOption(TunnelService);
    if (serviceOption._tag === "None") return yield* Effect.fail(unavailable(requested));
    const service = serviceOption.value;
    if (requested !== undefined && service.id !== requested)
      return yield* Effect.fail(unavailable(requested));
    return service;
  });

const resolvePlan = (
  cwd: string | undefined,
  target: ResolvedAppTarget | undefined,
): Effect.Effect<AppPlan, unknown, ShareServices> => {
  if (target !== undefined) return Effect.succeed(target.plan);
  return Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const landofile = yield* loadUserLandofileAt(landofileService, cwd ?? process.cwd());
    const capabilities = yield* registry.capabilities;
    return yield* planner.plan(landofile, capabilities);
  });
};

export const appShare = (
  options: ShareOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<
  TunnelSessionType,
  TunnelError | TunnelProviderUnavailableError | unknown,
  ShareServices | Scope.Scope
> =>
  Effect.gen(function* () {
    const service = yield* resolveTunnelService(options.provider);
    const plan = yield* resolvePlan(options.cwd, target);
    const tunnelTarget = options.target ?? ({ _tag: "route", routeId: plan.id } satisfies TunnelTargetType);
    const start = service.start({
      app: plan.id,
      target: tunnelTarget,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      detached: options.detach === true,
      plan,
    });
    return yield* options.detach === true ? Effect.scoped(start) : start;
  });

export const appShareList = (
  options: ShareListOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<
  ReadonlyArray<TunnelSessionType>,
  TunnelError | TunnelProviderUnavailableError | unknown,
  ShareServices
> =>
  Effect.gen(function* () {
    const service = yield* resolveTunnelService(options.provider);
    const app = target?.plan.id;
    return yield* service.list({
      ...(app === undefined ? {} : { app }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    });
  });

export const appShareStop = (
  options: ShareStopOptions,
): Effect.Effect<ShareStopResult, TunnelError | TunnelProviderUnavailableError> =>
  Effect.gen(function* () {
    const service = yield* resolveTunnelService(options.provider);
    yield* service.stop({
      sessionId: options.sessionId,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.force === undefined ? {} : { force: options.force }),
    });
    return { sessionId: options.sessionId, provider: service.id, status: "stopped" as TunnelStatusType };
  });

const renderJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const renderShareResult = (
  result: TunnelSessionType,
  format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (format === "json") return renderJson(result);
  const target =
    result.target._tag === "service" ? `${result.target.service}:${result.target.port}` : result.target._tag;
  return `Tunnel ${result.id} ${result.status} via ${result.provider} (${target})${
    result.publicUrl === undefined ? "" : ` at ${result.publicUrl}`
  }\n`;
};

export const renderShareListResult = (
  result: ReadonlyArray<TunnelSessionType>,
  format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (format === "json") return renderJson(result);
  if (result.length === 0) return "No active tunnels.\n";
  return `${result.map((session) => `${session.id}\t${session.provider}\t${session.status}`).join("\n")}\n`;
};

export const renderShareStopResult = (
  result: ShareStopResult,
  format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (format === "json") return renderJson(result);
  return `Tunnel ${result.sessionId} stopped.\n`;
};
