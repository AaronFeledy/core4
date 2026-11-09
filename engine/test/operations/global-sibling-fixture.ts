import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  AbsolutePath,
  type AppPlan,
  PluginManifest,
  ProviderId,
  ServiceName,
  type ServiceRunStatus,
} from "@lando/sdk/schema";
import {
  EventService,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema, Stream } from "effect";
import { reconcileGlobalSiblings } from "../../src/operations/global-retained-plan.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { plan as base } from "./global-stop-selection-fixture.ts";

export const desired: AppPlan = { ...base, routes: [], networking: { perAppBridge: null } };
export const oldBridge: AppPlan = {
  ...desired,
  networking: {
    perAppBridge: { name: "lando-global", driver: "bridge", aliases: {} },
  },
};

export const observation = (status: ServiceRunStatus = "running", id = "sibling"): ServiceRuntimeInfo => ({
  app: desired.id,
  appRoot: desired.root,
  providerId: desired.provider,
  service: ServiceName.make(id),
  containerId: `${id}-container`,
  status,
  labels: { "dev.lando.app": "global", "dev.lando.app-root": desired.root, "dev.lando.service": id },
  publications: { status: "unknown" },
});

export const fixture = (
  options: {
    readonly prior?: AppPlan;
    readonly desired?: AppPlan;
    readonly observed?: readonly ServiceRuntimeInfo[];
    readonly disabled?: boolean;
    readonly unreadable?: boolean;
  } = {},
) => {
  const plan = options.desired ?? desired;
  let lists = 0;
  const notices: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    list: () =>
      Effect.sync(() => {
        lists++;
        return options.observed ?? [observation()];
      }),
  };
  const registry = RuntimeProviderRegistry.of({
    assertAppliedStateReadable: () =>
      options.unreadable
        ? Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "applied-state.read",
              message: "Unreadable global record.",
              remediation: "Restore the global record, then run `lando global:start`.",
            }),
          )
        : Effect.void,
    appliedPlansFor: () => Effect.succeed(options.prior === undefined ? [] : [options.prior]),
    resolveAppliedPlan: () => Effect.succeed(options.prior),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const layer = Layer.mergeAll(
    makeTestStateStore().layer,
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(MessageInfoEvent)(event)) notices.push(event.body);
          }),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: "/tmp/global-sibling-test-data",
        userConfRoot: "/tmp/global-sibling-test-conf",
        userCacheRoot: "/tmp/global-sibling-test-cache",
        systemPluginRoot: "/tmp/global-sibling-test-plugins",
        platform: "linux",
        env: {},
      }),
    ),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(plan.root),
        providerId: Effect.succeed(plan.provider),
        paths: Effect.succeed({
          root: plan.root,
          distLandofile: AbsolutePath.make(`${plan.root}/.lando.dist.yml`),
          userLandofile: AbsolutePath.make(`${plan.root}/.lando.yml`),
        }),
        ensureRoot: Effect.void,
        ensureUserLandofile: Effect.die("unused"),
        ensureRunning: () => Effect.die("unused"),
        regenerateDist: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: "@example/siblings",
            version: "1.0.0",
            api: 4,
            contributes: {
              globalServices: [
                { id: "sibling", module: "/missing/sibling.ts", enabledByDefault: !options.disabled },
              ],
            },
          }),
        ]),
        load: () => Effect.die("unused"),
        loadServiceType: () => Effect.die("unused"),
        loadServiceFeature: () => Effect.die("unused"),
        loadAppFeature: () => Effect.die("unused"),
      }),
    ),
  );
  const reconcile = (
    close = (ids: ReadonlySet<string>) => new Set(ids),
    selectedIds: readonly string[] = ["mail"],
  ) =>
    Effect.runPromise(
      Effect.result(reconcileGlobalSiblings(plan, provider, { selectedIds, close })).pipe(
        Effect.provide(layer),
      ),
    );
  return { reconcile, lists: () => lists, notices: () => notices };
};
