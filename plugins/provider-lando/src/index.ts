/**
 * `@lando/provider-lando` — Lando-managed RuntimeProvider.
 *
 * Status: MVP capability surface; lifecycle methods land in later provider stories.
 */
import { Effect, Layer, Schema, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, PluginManifest } from "@lando/sdk/schema";
import { RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

import { bringDown } from "./bring-down.ts";
import { type BringUpOptions, bringUp } from "./bring-up.ts";
import {
  type PodmanApiClient,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  makePodmanApiClient,
} from "./capabilities.ts";
import { exec, execStream } from "./exec.ts";
import { inspect } from "./inspect.ts";
import { logs } from "./logs.ts";

export { composePath, emitCompose, renderCompose } from "./compose.ts";
export type { EmitComposeOptions, EmitComposeResult } from "./compose.ts";
export { bringUp } from "./bring-up.ts";
export type { BringUpOptions } from "./bring-up.ts";
export { bringDown } from "./bring-down.ts";
export type { BringDownOptions } from "./bring-down.ts";
export { exec, execStream } from "./exec.ts";
export type { ExecOptions } from "./exec.ts";
export { inspect } from "./inspect.ts";
export type { InspectOptions } from "./inspect.ts";
export { logs } from "./logs.ts";
export type { LogsOptions } from "./logs.ts";

export {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  makePodmanApiClient,
  makePodmanInfoRequest,
} from "./capabilities.ts";
export type { PodmanApiClient, PodmanApiRequest } from "./capabilities.ts";

export const PLUGIN_NAME = "@lando/provider-lando" as const;

const makeUnavailable = (operation: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message: `provider-lando does not implement ${operation} yet.`,
  });

export interface ProviderLayerOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly socketPath?: string;
  readonly eventService?: BringUpOptions["eventService"];
}

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
  const podmanApi =
    options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));
  const capabilities =
    podmanApi === undefined
      ? Effect.succeed(linuxMvpCapabilities)
      : introspectProviderCapabilities(podmanApi);

  return capabilities.pipe(
    Effect.map(
      (resolvedCapabilities): RuntimeProviderShape => ({
        id: "lando",
        displayName: "Lando Runtime Provider",
        version: "0.0.0",
        platform: process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32",
        capabilities: resolvedCapabilities,
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0" }),
        buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
        pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
        removeArtifact: () => Effect.void,
        apply: (plan) =>
          bringUp(plan, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          }).pipe(Effect.tap(() => Effect.sync(() => plans.set(plan.id, plan)))),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        destroy: (target) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.void
            : bringDown(plan, { ...(podmanApi === undefined ? {} : { podmanApi }) }).pipe(
                Effect.tap(() => Effect.sync(() => plans.delete(target.app))),
                Effect.asVoid,
              );
        },
        exec: (target, command) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.fail(makeUnavailable("exec"))
            : exec(plan, target, command, { ...(podmanApi === undefined ? {} : { podmanApi }) });
        },
        execStream: (target, command) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Stream.fail(makeUnavailable("execStream"))
            : execStream(plan, target, command, { ...(podmanApi === undefined ? {} : { podmanApi }) });
        },
        run: () => Effect.fail(makeUnavailable("run")),
        logs: (target, logOptions) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Stream.fail(makeUnavailable("logs"))
            : logs(plan, target, logOptions, { ...(podmanApi === undefined ? {} : { podmanApi }) });
        },
        inspect: (target) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.fail(makeUnavailable("inspect"))
            : inspect(plan, target, { ...(podmanApi === undefined ? {} : { podmanApi }) });
        },
        list: (filter) =>
          Effect.forEach(Array.from(plans.values()), (plan) =>
            Effect.forEach(Object.values(plan.services), (service) =>
              inspect(
                plan,
                { app: plan.id, service: service.name },
                { ...(podmanApi === undefined ? {} : { podmanApi }) },
              ),
            ),
          ).pipe(
            Effect.map((snapshots) => snapshots.flat()),
            Effect.map((snapshots) =>
              filter.app === undefined
                ? snapshots
                : snapshots.filter((snapshot) => snapshot.app === filter.app),
            ),
          ),
      }),
    ),
  );
};

export const makeProviderLayer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const provider = makeProviderLayer();

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Reference Lando-managed RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: ["lando"] },
  entry: "./src/index.ts",
});
