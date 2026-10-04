import { Effect, Schema, type Scope } from "effect";

import type { AppPlanResolutionError, ShareAppError } from "@lando/sdk/app";
import { type StateStoreError, TunnelProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  TunnelSession,
  type TunnelSession as TunnelSessionType,
  TunnelStatus,
  TunnelStopRequest,
  TunnelTarget,
  type TunnelTarget as TunnelTargetType,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type StateStore,
  type TunnelError,
  TunnelService,
} from "@lando/sdk/services";

import { routerEnabled } from "../config/router-config.ts";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";
import { reconcileTunnelRegistry, recordTunnelSession, removeTunnelSession } from "../tunnel/registry.ts";

export const ShareStopResultSchema = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.optionalKey(Schema.String),
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

export type ShareCommandError =
  | AppPlanResolutionError
  | TunnelError
  | TunnelProviderUnavailableError
  | Schema.SchemaError
  | StateStoreError;

export type ShareListCommandError =
  | AppPlanResolutionError
  | TunnelError
  | TunnelProviderUnavailableError
  | StateStoreError;

export type ShareStopCommandError =
  | TunnelError
  | TunnelProviderUnavailableError
  | Schema.SchemaError
  | StateStoreError;

type ShareRuntimeError = TunnelError | TunnelProviderUnavailableError | Schema.SchemaError | StateStoreError;
type ShareListRuntimeError = TunnelError | TunnelProviderUnavailableError | StateStoreError;

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

const resolveTunnelService = Effect.fnUntraced(function* (requested?: string) {
  const serviceOption = yield* Effect.serviceOption(TunnelService);
  if (serviceOption._tag === "None") return yield* Effect.fail(unavailable(requested));
  const service = serviceOption.value;
  if (requested !== undefined && service.id !== requested) return yield* Effect.fail(unavailable(requested));
  return service;
});

const resolvePlan = Effect.fnUntraced(function* (
  cwd: string | undefined,
  target: ResolvedAppTarget | undefined,
): Effect.fn.Return<AppPlan, AppPlanResolutionError, ShareServices> {
  if (target !== undefined) return target.plan;
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;
  const landofile = yield* loadUserLandofileAt(landofileService, cwd ?? process.cwd());
  const capabilities = yield* registry.capabilities;
  return yield* planner.plan(landofile, capabilities);
});

/**
 * Default share target. A shared-router hostname is only reachable when the
 * router publishes it, so a disabled router shares the app itself instead.
 */
export const defaultTunnelTarget = (plan: AppPlan): TunnelTargetType => {
  const firstRoute = routerEnabled(plan) ? plan.routes[0] : undefined;
  if (firstRoute !== undefined)
    return { _tag: "route", routeId: firstRoute.hostname, hostname: firstRoute.hostname };
  return { _tag: "route", routeId: plan.id };
};

const appShareWithPlan = Effect.fnUntraced(function* <E, R>(
  options: ShareOptions,
  planEffect: Effect.Effect<AppPlan, E, R>,
): Effect.fn.Return<TunnelSessionType, ShareRuntimeError | E, R | Scope.Scope | StateStore> {
  const service = yield* resolveTunnelService(options.provider);
  const plan = yield* planEffect;
  const tunnelTarget = yield* Schema.decodeUnknownEffect(TunnelTarget)(
    options.target ?? defaultTunnelTarget(plan),
  );
  const start = service.start({
    app: plan.id,
    target: tunnelTarget,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    detached: options.detach === true,
    plan,
  });
  if (options.detach === true) {
    const session = yield* Effect.scoped(start);
    yield* recordTunnelSession(session);
    return session;
  }

  const session = yield* start;
  yield* recordTunnelSession(session);
  yield* Effect.addFinalizer(() => removeTunnelSession(session.id).pipe(Effect.catch(() => Effect.void)));
  return session;
});

export const appShareForTarget = Effect.fn("AppOperation.shareForTarget")(function* (
  options: ShareOptions | undefined,
  target: ResolvedAppTarget,
): Effect.fn.Return<TunnelSessionType, ShareAppError, Scope.Scope | StateStore> {
  return yield* appShareWithPlan(options ?? {}, Effect.succeed(target.plan));
});

export const appShare = Effect.fn("AppOperation.share")(function* (
  options: ShareOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<TunnelSessionType, ShareCommandError, ShareServices | Scope.Scope | StateStore> {
  return yield* appShareWithPlan(options, resolvePlan(options.cwd, target));
});

const appShareListWithPlan = Effect.fnUntraced(function* <E, R>(
  options: ShareListOptions,
  planEffect: Effect.Effect<AppPlan, E, R>,
): Effect.fn.Return<ReadonlyArray<TunnelSessionType>, ShareListRuntimeError | E, R | StateStore> {
  const service = yield* resolveTunnelService(options.provider);
  const plan = yield* planEffect;
  const app = plan.id;
  const listed = yield* service.list({
    app,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });
  const reconciled = yield* reconcileTunnelRegistry(new Set(listed.map((session) => session.id)));
  const byId = new Map<string, TunnelSessionType>();
  for (const session of reconciled) byId.set(session.id, session);
  for (const session of listed) byId.set(session.id, session);
  return Array.from(byId.values()).filter(
    (session) =>
      session.app === app && (options.provider === undefined || session.provider === options.provider),
  );
});

export const appShareListForTarget = Effect.fn("AppOperation.shareListForTarget")(function* (
  options: ShareListOptions | undefined,
  target: ResolvedAppTarget,
): Effect.fn.Return<ReadonlyArray<TunnelSessionType>, ShareAppError, StateStore> {
  return yield* appShareListWithPlan(options ?? {}, Effect.succeed(target.plan));
});

export const appShareList = Effect.fn("AppOperation.shareList")(function* (
  options: ShareListOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<ReadonlyArray<TunnelSessionType>, ShareListCommandError, ShareServices | StateStore> {
  return yield* appShareListWithPlan(options, resolvePlan(options.cwd, target));
});

export const appShareStop = Effect.fn("AppOperation.shareStop")(function* (
  options: ShareStopOptions,
): Effect.fn.Return<ShareStopResult, ShareStopCommandError, StateStore> {
  const stopRequest = yield* Schema.decodeUnknownEffect(TunnelStopRequest)({
    sessionId: options.sessionId,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  const service = yield* resolveTunnelService(stopRequest.provider);
  yield* service.stop(stopRequest);
  yield* removeTunnelSession(stopRequest.sessionId);
  return { sessionId: stopRequest.sessionId, provider: service.id, status: "stopped" };
});
