import { Effect, Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { commitGlobalPolicy, prepareGlobalPolicy } from "../global-app/enablement.ts";
import { withGlobalMutation } from "../global-app/mutation.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import { recordGlobalGeneration } from "../global-app/reconciliation.ts";
import {
  type GlobalResolution,
  assertEffectiveGlobalServices,
  assertGlobalResolution,
  projectEffectiveGlobalResolution,
  readGlobalResolution,
} from "../global-app/resolution.ts";
import { renderGlobalDist } from "../global-app/service.ts";
import { hostProviderId } from "../providers/host-provider.ts";
import { validateLandofileReplacement } from "../services/landofile-live.ts";

export interface GlobalInstallOptions {
  readonly services?: ReadonlyArray<string>;
}

const GlobalAppPathsResultSchema = Schema.Struct({
  root: AbsolutePath,
  distLandofile: AbsolutePath,
  userLandofile: AbsolutePath,
});

export const GlobalDistResultSchema = Schema.Struct({
  path: AbsolutePath,
  status: Schema.Literals(["created", "updated", "unchanged"]),
  serviceIds: Schema.Array(Schema.String),
});

export const GlobalInstallResultSchema = Schema.Struct({
  paths: GlobalAppPathsResultSchema,
  dist: GlobalDistResultSchema,
  userLandofileCreated: Schema.Boolean,
});
export type GlobalInstallResult = typeof GlobalInstallResultSchema.Type;

/** Validate proposed defaults with the real authored layers without writing generated files. */
export const validateGlobalConfiguration = Effect.fn("GlobalApp.validateConfiguration")(function* (
  resolution: GlobalResolution,
  options: GlobalInstallOptions = {},
) {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const fileSystem = yield* FileSystem;
  const compiled = (yield* fileSystem.exists(paths.root))
    ? yield* validateLandofileReplacement(
        {
          appRoot: paths.root,
          targetFile: paths.distLandofile,
          content: renderGlobalDist(resolution.composableServices),
        },
        { name: "global", provider: yield* hostProviderId, excludedServices: resolution.directlyExcludedIds },
      )
    : undefined;
  const services = compiled?.document.services ?? resolution.composableServices;
  const pendingSites = compiled?.pendingSites ?? [];
  yield* assertEffectiveGlobalServices(
    resolution,
    services,
    options.services?.length ? options.services : undefined,
    pendingSites,
  );
  return {
    services,
    pendingSites,
    resolution: projectEffectiveGlobalResolution(resolution, services, pendingSites),
  };
});

/** Reconcile defaults and generated configuration without changing explicit user policy. */
export const globalInstall = Effect.fn("AppOperation.reconcileGlobalConfiguration")(
  function* (_options: GlobalInstallOptions = {}) {
    const globalApp = yield* GlobalAppService;
    const providers = yield* RuntimeProviderRegistry;
    const providerId = yield* globalCreateProviderId();
    const provider = yield* providers.select(providerId);
    const current = yield* readGlobalResolution({
      providerId,
      providerCapabilities: provider.capabilities,
    });
    const prepared = yield* prepareGlobalPolicy(current.policy, current.contributions);
    const policy = yield* commitGlobalPolicy(current.policy.revision, prepared.policy);
    const resolved = yield* readGlobalResolution({
      policy,
      providerId,
      providerCapabilities: provider.capabilities,
    });
    yield* assertGlobalResolution(resolved, _options.services?.length ? _options.services : undefined, {
      directOnly: true,
    });
    yield* Effect.scoped(globalApp.ensureRoot);
    const user = yield* globalApp.ensureUserLandofile;
    const validated = yield* validateGlobalConfiguration(resolved, _options);
    const dist = yield* globalApp.regenerateDist({ services: resolved.composableServices });
    if (validated.resolution.errors.length === 0) yield* recordGlobalGeneration(policy.revision);
    return {
      paths: yield* globalApp.paths,
      dist,
      userLandofileCreated: user.created,
    } satisfies GlobalInstallResult;
  },
  (effect, _options: GlobalInstallOptions = {}) => withGlobalMutation(effect),
);
