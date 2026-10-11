import { Effect } from "effect";

import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { FileSystem, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { type AppliedStateProvider, resolveTeardownEvidence } from "../providers/applied-state-resolution.ts";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../providers/managed.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { missingRootAppliedTarget } from "./applied-state-target.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";

export const resolveGlobalTeardown = Effect.fn("GlobalApp.resolveTeardown")(function* () {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(paths.root));
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
  const observedProvider = {
    ...provider,
    isAvailable: provider.isAvailable.pipe(
      Effect.flatMap((available) =>
        available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
      ),
      Effect.catch(() => Effect.succeed(false)),
    ),
  } satisfies AppliedStateProvider;
  const evidence = yield* resolveTeardownEvidence(root, [observedProvider]);
  if (evidence.kind === "applied") yield* missingRootAppliedTarget(evidence.plan, root);
  const fileSystem = yield* FileSystem;
  const materialized = yield* fileSystem.exists(paths.distLandofile);
  return { paths: { ...paths, root }, provider, evidence, materialized };
});

type GlobalTeardown = Effect.Success<ReturnType<typeof resolveGlobalTeardown>>;

export const globalTeardownAppRef = (resolved: GlobalTeardown) => ({
  kind: "global" as const,
  id: resolved.evidence.kind === "applied" ? resolved.evidence.plan.id : AppId.make("global"),
  root: resolved.paths.root,
});

export const executeGlobalTeardown = Effect.fn("GlobalApp.teardown")(function* (
  resolved: GlobalTeardown,
  options: { readonly volumes: boolean; readonly removeState: boolean },
) {
  switch (resolved.evidence.kind) {
    case "applied": {
      const plan = resolved.evidence.plan;
      const result = yield* resolved.provider.destroy({ app: plan.id, plan }, options);
      switch (result.kind) {
        case "no-op":
          return { changed: false, services: [], volumesRemoved: false };
        case "destroyed":
          return {
            changed: true,
            services: Object.values(plan.services)
              .reverse()
              .map((service) => String(service.name)),
            volumesRemoved: options.volumes,
          };
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    }
    case "orphans": {
      const result = yield* tearDownOrphans({
        root: resolved.paths.root,
        groups: resolved.evidence.groups,
        options: { volumes: options.volumes, purgeCaches: false },
      });
      return {
        changed: result.services.length > 0 || result.volumesRemoved,
        services: result.services,
        volumesRemoved: result.volumesRemoved,
      };
    }
    case "absent":
      return { changed: false, services: [], volumesRemoved: false };
    default: {
      const unreachable: never = resolved.evidence;
      return unreachable;
    }
  }
});
