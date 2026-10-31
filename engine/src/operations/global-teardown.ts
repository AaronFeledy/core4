import { AppResolveError } from "@lando/sdk/errors";
import { PostGlobalDestroyEvent, PreGlobalDestroyEvent } from "@lando/sdk/events";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId } from "@lando/sdk/schema";
import {
  EventService,
  FileSystem,
  GlobalAppService,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { globalObserveProviderId } from "../global-app/placement.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { type AppliedStateProvider, resolveTeardownEvidence } from "../providers/applied-state-resolution.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { missingRootAppliedTarget } from "./applied-state-target.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import { removeGlobalResources } from "./global-teardown-resources.ts";
import { unknownPlanServiceError } from "./unknown-service.ts";

const runtimeOnline = (provider: Pick<RuntimeProviderShape, "isAvailable" | "getStatus">) =>
  provider.isAvailable.pipe(
    Effect.flatMap((available) =>
      available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );

export const resolveGlobalTeardown = Effect.fn("GlobalApp.resolveTeardown")(function* () {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(paths.root));
  const registry = yield* RuntimeProviderRegistry;
  const explicit = yield* TeardownProvider;
  const providerId = explicit ?? (yield* globalObserveProviderId);
  const provider = yield* registry.select(providerId);
  const resourceOwnership = registry.resourceOwnership;
  const ownership = yield* resourceOwnership?.(providerId, root) ?? Effect.succeed(undefined);
  const observedProvider = {
    ...provider,
    isAvailable: runtimeOnline(provider),
    ...(resourceOwnership === undefined ? {} : { resourceOwnership: () => Effect.succeed(ownership) }),
    canCleanupOwnedResources: Effect.succeed(provider.cleanupOwnedResources !== undefined),
  } satisfies AppliedStateProvider;
  const evidence = yield* resolveTeardownEvidence(root, [observedProvider]);
  if (evidence.kind === "applied") yield* missingRootAppliedTarget(evidence.plan, root);
  const fileSystem = yield* FileSystem;
  const materialized = yield* fileSystem.exists(paths.distLandofile);
  return { paths: { ...paths, root }, provider, evidence, materialized };
});

export type GlobalTeardown = Effect.Success<ReturnType<typeof resolveGlobalTeardown>>;

export const resolveGlobalStopSelection = Effect.fn("GlobalApp.resolveStopSelection")(function* (
  resolved: GlobalTeardown,
  requested: ReadonlyArray<string>,
  options?: { readonly requireOnline?: boolean },
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
  const online = options?.requireOnline
    ? yield* resolved.provider.isAvailable.pipe(
        Effect.flatMap((available) =>
          available
            ? Effect.map(resolved.provider.getStatus, (status) => status.running)
            : Effect.succeed(false),
        ),
      )
    : yield* runtimeOnline(resolved.provider);
  if (options?.requireOnline && !online)
    return yield* Effect.fail(
      new AppResolveError({
        message:
          "The applied global provider is offline; selected containers and routes could not be removed.",
        reason: "mismatch",
        detail: "provider-resources",
        remediation: "Start the applied provider and repeat this uninstall command.",
      }),
    );
  const observed = online
    ? yield* resolved.provider.list({ app: evidence.plan.id, includeUnplanned: true })
    : [];
  const owned = observed.filter(
    (service) =>
      service.app === evidence.plan.id &&
      service.appRoot === resolved.paths.root &&
      service.providerId === evidence.plan.provider &&
      service.containerId !== undefined,
  );
  const activeNames = new Set(
    owned
      .filter(
        (service) =>
          service.status === "running" || service.status === "paused" || service.status === "restarting",
      )
      .map((service) => String(service.service)),
  );
  const selected = new Set(requested);
  return {
    plan: evidence.plan,
    services: Object.values(evidence.plan.services)
      .reverse()
      .flatMap((service) =>
        selected.has(String(service.name))
          ? owned.filter((observation) => observation.service === service.name)
          : [],
      ),
    routes:
      online && evidence.plan.routes.some((route) => selected.has(String(route.service)))
        ? evidence.plan.routes.filter(
            (route) => !selected.has(String(route.service)) && activeNames.has(String(route.service)),
          )
        : undefined,
  };
});

export const executeGlobalStopSelection = Effect.fn("GlobalApp.stopSelection")(function* (
  resolved: GlobalTeardown,
  selection: Effect.Success<ReturnType<typeof resolveGlobalStopSelection>>,
) {
  const services: string[] = [];
  for (const service of selection.services) {
    const result = yield* resolved.provider.removeObservedService(service);
    switch (result.kind) {
      case "removed":
        services.push(String(service.service));
        break;
      case "absent":
        break;
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  }
  if (selection.routes !== undefined) {
    const router = yield* RouterService;
    yield* router.applyRoutes(selection.routes, selection.plan.id);
  }
  return {
    changed: services.length > 0,
    services,
  };
});

export const globalTeardownAppRef = (resolved: GlobalTeardown) => ({
  kind: "global" as const,
  id: resolved.evidence.kind === "applied" ? resolved.evidence.plan.id : AppId.make("global"),
  root: resolved.paths.root,
});

export const executeGlobalTeardown = Effect.fn("GlobalApp.teardown")(function* (
  resolved: GlobalTeardown,
  options: { readonly intent: "stop" | "destroy"; readonly volumes: boolean; readonly removeState: boolean },
) {
  const evidence = resolved.evidence.kind;
  if (evidence === "absent") return { changed: false, services: [], volumesRemoved: false };
  const work = removeGlobalResources(resolved, {
    volumes: options.volumes,
    removeState: options.removeState,
  });
  switch (options.intent) {
    case "stop":
      return yield* work;
    case "destroy":
      break;
    default:
      return options.intent satisfies never;
  }
  const events = yield* EventService;
  const router = yield* RouterService;
  const app = globalTeardownAppRef(resolved);
  const payload = { scope: "global" as const, app, evidence, purge: options.volumes };
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
      yield* router.removeRoutes(app.id).pipe(Effect.tapError(() => tree.failTask("routes")));
      yield* tree.completeTask("routes");
      return result;
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
