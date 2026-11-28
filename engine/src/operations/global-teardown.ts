import { adoptionReceiptsFromSummary } from "@lando/container-runtime/native-ownership";
import { AppResolveError } from "@lando/sdk/errors";
import { PostGlobalDestroyEvent, PreGlobalDestroyEvent } from "@lando/sdk/events";
import {
  AbsolutePath,
  AppId,
  type ContainerBringDownReceipt,
  type ServiceShutdownObservation,
  isActiveRunStatus,
  noVolumesRemoved,
} from "@lando/sdk/schema";
import { EventService, FileSystem, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import { globalObserveProviderId } from "../global-app/placement.ts";
import { type GlobalResolution, readGlobalResolution } from "../global-app/resolution.ts";
import { routeOwnerFromGlobalTeardown, routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import {
  republishRetainedRoutes,
  settleRoutesTask,
  withdrawOwnerRoutes,
} from "../lifecycle/route-withdrawal.ts";
import { TeardownProvider, requireOwningEngine } from "../providers/app-placement.ts";
import { type AppliedStateProvider, resolveTeardownEvidence } from "../providers/applied-state-resolution.ts";
import { observeRuntime, prepareTeardownOwners, runtimeOnline } from "../providers/runtime-observation.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { missingRootAppliedTarget } from "./applied-state-target.ts";
import { currentDataRoot, serviceInDataRoot } from "./data-root-scope.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import { removeGlobalResources, stopGlobalResources } from "./global-teardown-resources.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { stopIdleApp } from "./stop-idle.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { unknownPlanServiceError } from "./unknown-service.ts";

export const resolveGlobalTeardown = Effect.fn("GlobalApp.resolveTeardown")(function* (
  intent: "stop" | "destroy" = "stop",
) {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(paths.root));
  const registry = yield* RuntimeProviderRegistry;
  const explicit = yield* TeardownProvider;
  const providerId = explicit ?? (yield* globalObserveProviderId);
  const recorded = yield* registry.readAppliedPlanStrict({ id: AppId.make("global"), provider: providerId });
  const plans =
    recorded !== undefined && (recorded.identity?.appRoot ?? recorded.root) === root ? [recorded] : [];
  const provider = yield* registry.select(providerId);
  yield* requireOwningEngine(provider, "global", plans);
  const resourceOwnership = registry.resourceOwnership;
  const ownership = yield* resourceOwnership?.(providerId, root) ?? Effect.succeed(undefined);
  if (intent === "destroy" && (ownership !== undefined || plans.length > 0))
    yield* prepareTeardownOwners([provider]);
  const observedProvider = {
    ...provider,
    appliedStateInventory: Effect.succeed({ plans, unreadable: [] }),
    isAvailable: observeRuntime(provider).pipe(
      Effect.flatMap((observation) =>
        observation.kind === "unavailable"
          ? observation.error === undefined
            ? Effect.succeed(false)
            : Effect.fail(observation.error)
          : Effect.succeed(true),
      ),
    ),
    runtimeOnline: runtimeOnline(provider),
    ...(resourceOwnership === undefined ? {} : { resourceOwnership: () => Effect.succeed(ownership) }),
    canCleanupOwnedResources: Effect.succeed(provider.cleanupOwnedResources !== undefined),
  } satisfies AppliedStateProvider;
  const evidence = yield* resolveTeardownEvidence(
    root,
    [observedProvider],
    { kind: "global", id: "global" },
    yield* currentDataRoot,
  );
  if (evidence.kind === "applied") yield* missingRootAppliedTarget(evidence.plan, root);
  const fileSystem = yield* FileSystem;
  const materialized = yield* fileSystem.exists(paths.distLandofile);
  return { paths: { ...paths, root }, provider, evidence, materialized };
});

export type GlobalTeardown = Effect.Success<ReturnType<typeof resolveGlobalTeardown>>;

export const resolveGlobalStopSelection = Effect.fn("GlobalApp.resolveStopSelection")(function* (
  resolved: GlobalTeardown,
  requested: ReadonlyArray<string>,
  options?: { readonly requireOnline?: boolean; readonly resolution?: GlobalResolution },
) {
  const evidence = resolved.evidence;
  let services: ReadonlyArray<{ readonly name: string }>;
  switch (evidence.kind) {
    case "applied":
      services = Object.values(evidence.plan.services);
      break;
    case "orphans":
      services = evidence.groups.flatMap((group) =>
        group.services.map((service) => ({ name: service.service })),
      );
      break;
    case "owned":
    case "absent":
      services = [];
      break;
    default: {
      const unreachable: never = evidence;
      return unreachable;
    }
  }
  const available = Object.fromEntries(services.map((service) => [String(service.name), service]));
  const missing = requested.find((name) => !Object.hasOwn(available, name));
  if (missing !== undefined)
    return yield* Effect.fail(
      unknownPlanServiceError({
        prefix: "meta:global:stop",
        tool: "meta:global:stop",
        requested: missing,
        services: available,
        planLabel: "global app plan",
        remediation: (first) => `Example: lando global:stop --service ${first}`,
      }),
    );
  switch (evidence.kind) {
    case "applied":
      break;
    case "orphans":
    case "owned":
    case "absent":
      return yield* Effect.fail(
        new AppResolveError({
          message: "Selected global services cannot be stopped without matching applied app state.",
          reason: "mismatch",
          detail: "provider-resources",
          remediation: "Restore the matching applied state before retrying service-scoped global:stop.",
        }),
      );
    default: {
      const unreachable: never = evidence;
      return unreachable;
    }
  }
  const online = yield* runtimeOnline(resolved.provider);
  if (options?.requireOnline && !online)
    return yield* Effect.fail(
      new AppResolveError({
        message:
          "The applied global provider is offline; selected containers and routes could not be removed.",
        reason: "mismatch",
        detail: "provider-resources",
        remediation: "Start the applied provider and repeat the selected cleanup command.",
      }),
    );
  const observed = online
    ? yield* resolved.provider.list({ app: evidence.plan.id, includeUnplanned: true })
    : [];
  const receipts = (evidence.ownership ?? []).flatMap(adoptionReceiptsFromSummary);
  const owned = observed.filter(
    (service) =>
      service.app === evidence.plan.id &&
      service.appRoot === resolved.paths.root &&
      serviceInDataRoot(service, evidence.plan.identity?.dataRoot, receipts) &&
      service.providerId === evidence.plan.provider &&
      service.containerId !== undefined,
  );
  const activeNames = new Set(
    owned.filter((service) => isActiveRunStatus(service.status)).map((service) => String(service.service)),
  );
  const selected = new Set(requested);
  const updateRoutes = online && evidence.plan.routes.some((route) => selected.has(String(route.service)));
  const retainedRoutes = evidence.plan.routes.filter(
    (route) => !selected.has(String(route.service)) && activeNames.has(String(route.service)),
  );
  // Applied routes may outlive a failed disable; blocked but enabled siblings still own their routes.
  const routePolicy =
    updateRoutes && retainedRoutes.length > 0
      ? yield* (
          options?.resolution === undefined ? readGlobalResolution() : Effect.succeed(options.resolution)
        ).pipe(Effect.result)
      : undefined;
  const disabled = new Set(
    routePolicy?._tag === "Success"
      ? routePolicy.success.entries.filter((entry) => !entry.enabled).map((entry) => entry.id)
      : [],
  );
  return {
    plan: evidence.plan,
    services: Object.values(evidence.plan.services)
      .reverse()
      .flatMap((service) =>
        selected.has(String(service.name))
          ? owned.filter((observation) => observation.service === service.name)
          : [],
      ),
    routes: updateRoutes ? retainedRoutes.filter((route) => !disabled.has(String(route.service))) : undefined,
    routePolicyError: routePolicy?._tag === "Failure" ? routePolicy.failure : undefined,
  };
});

export const executeGlobalStopSelection = Effect.fn("GlobalApp.stopSelection")(function* (
  resolved: GlobalTeardown,
  selection: Effect.Success<ReturnType<typeof resolveGlobalStopSelection>>,
) {
  const services: string[] = [];
  const containers: ContainerBringDownReceipt[] = [];
  const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const service of selection.services) {
    const { shutdownObservations, ...result } = yield* resolved.provider.bringDownObserved(service, "stop");
    observationSources.push(shutdownObservations);
    containers.push(result);
    switch (result.action) {
      case "removed":
      case "stopped":
        services.push(String(service.service));
        break;
      case "already-stopped":
      case "absent":
        break;
      default: {
        const unreachable: never = result.action;
        return unreachable;
      }
    }
  }
  if (selection.routePolicyError !== undefined) return yield* Effect.fail(selection.routePolicyError);
  if (selection.routes !== undefined)
    yield* republishRetainedRoutes(
      selection.routes,
      routeOwnerFromPlan(selection.plan),
      selection.services.map((service) => String(service.service)),
    );
  return withShutdownObservations(
    {
      changed: services.length > 0,
      services,
      containers,
    },
    ...observationSources,
  );
});

export const globalTeardownAppRef = (resolved: GlobalTeardown) => ({
  kind: "global" as const,
  id: resolved.evidence.kind === "applied" ? resolved.evidence.plan.id : AppId.make("global"),
  root: resolved.paths.root,
});

export const executeGlobalTeardown = Effect.fn("GlobalApp.teardown")(function* (
  resolved: GlobalTeardown,
  // Stop keeps every resource, so only destroy chooses what to remove.
  options:
    | { readonly intent: "stop" | "halt" }
    | {
        readonly intent: "destroy";
        readonly volumes: boolean;
        readonly removeState: boolean;
        readonly purge?: boolean;
      },
) {
  const evidence = resolved.evidence.kind;
  if (evidence === "absent")
    return withShutdownObservations({
      changed: false,
      services: [],
      volumesRemoved: { ...noVolumesRemoved },
      containers: [],
    });
  if (options.intent !== "destroy" && (yield* resolved.provider.getStatus).state === "idle") {
    if (resolved.evidence.kind !== "applied")
      return withShutdownObservations({
        changed: false,
        services: [],
        volumesRemoved: { ...noVolumesRemoved },
        containers: [],
      });
    const target = {
      plan: resolved.evidence.plan,
      root: resolved.paths.root,
      app: globalTeardownAppRef(resolved),
    };
    yield* stopIdleApp(target, yield* preflightStopApp(target, "idle"));
    const routes =
      options.intent === "stop"
        ? (yield* withdrawOwnerRoutes(routeOwnerFromPlan(resolved.evidence.plan))).kind
        : undefined;
    return withShutdownObservations({
      changed: true,
      services: [],
      volumesRemoved: { ...noVolumesRemoved },
      containers: [],
      ...(routes === undefined ? {} : { routes }),
    });
  }
  switch (options.intent) {
    case "halt":
    case "stop":
      return yield* stopGlobalResources(resolved);
    case "destroy":
      break;
    default:
      return options satisfies never;
  }
  const work = removeGlobalResources(resolved, {
    volumes: options.volumes,
    removeState: options.removeState,
  });
  const events = yield* EventService;
  const app = globalTeardownAppRef(resolved);
  const payload = {
    scope: "global" as const,
    app,
    evidence,
    volumes: options.volumes,
    purge: options.purge === true,
  };
  yield* events.publish(PreGlobalDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
  const result = yield* withDestroyProgress({
    events,
    plan: { id: app.id, name: "global" },
    children: { fileSync: false, snapshots: false, provider: true, hostProxy: false, proxy: true },
    work: Effect.fnUntraced(function* (tree) {
      yield* tree.startTask("provider");
      const result = yield* work.pipe(Effect.tapError(() => tree.failTask("provider")));
      yield* tree.completeTask("provider");
      yield* tree.startTask("routes");
      const withdrawal = yield* withdrawOwnerRoutes(routeOwnerFromGlobalTeardown(resolved)).pipe(
        Effect.tapError(() => tree.failTask("routes")),
      );
      yield* settleRoutesTask(tree, withdrawal);
      return { ...result, routes: withdrawal.kind };
    }),
  });
  yield* events.publish(
    PostGlobalDestroyEvent.make({
      ...payload,
      outcome: result.changed ? "destroyed" : "unchanged",
      timestamp: DateTime.nowUnsafe(),
    }),
  );
  return result;
});
