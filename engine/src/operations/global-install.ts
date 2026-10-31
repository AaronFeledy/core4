import { canonicalJson } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";
import { AppPlanner, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { commitGlobalPolicy, prepareGlobalPolicy } from "../global-app/enablement.ts";
import { withGlobalMutation } from "../global-app/mutation.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import { prepareGlobalConfiguration } from "../global-app/preparation.ts";
import { recordGlobalGeneration } from "../global-app/reconciliation.ts";
import {
  type GlobalResolution,
  assertEffectiveGlobalServices,
  assertGlobalResolution,
  projectEffectiveGlobalResolution,
} from "../global-app/resolution.ts";
import { renderGlobalDist } from "../global-app/service.ts";
import { hostProviderId } from "../providers/host-provider.ts";
import { prepareLandofileReplacement } from "../services/landofile-live.ts";
import { withProcessCwd } from "./global-plan.ts";

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
  const replacement = yield* prepareLandofileReplacement(
    {
      appRoot: paths.root,
      targetFile: paths.distLandofile,
      content: renderGlobalDist(resolution.composableServices),
    },
    { name: "global", provider: yield* hostProviderId, excludedServices: resolution.directlyExcludedIds },
  );
  const compiled = replacement.landofile;
  const services = compiled.document.services ?? {};
  const pendingSites = compiled.pendingSites;
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
const installPreparedConfiguration = Effect.fn("AppOperation.installPreparedConfiguration")(
  function* (_options: GlobalInstallOptions = {}) {
    const globalApp = yield* GlobalAppService;
    const providers = yield* RuntimeProviderRegistry;
    const providerId = yield* globalCreateProviderId();
    const provider = yield* providers.select(providerId);
    const preparation = yield* prepareGlobalConfiguration({
      providerId,
      providerCapabilities: provider.capabilities,
    });
    const current = yield* preparation.resolve();
    const prepared = yield* prepareGlobalPolicy(current.policy, current.contributions);
    const resolved = yield* preparation.resolve(prepared.policy);
    yield* assertGlobalResolution(resolved, _options.services?.length ? _options.services : undefined, {
      directOnly: true,
    });
    const candidate = yield* preparation.compile(resolved, _options.services);
    yield* candidate.verify;
    const policy = yield* commitGlobalPolicy(current.policy.revision, prepared.policy);
    yield* candidate.verify;
    const dist = yield* globalApp.regenerateDist({
      services: resolved.composableServices,
      content: candidate.content,
    });
    const user = yield* globalApp.ensureUserLandofile;
    if (candidate.resolution.errors.length === 0) yield* recordGlobalGeneration(policy.revision);
    return {
      candidate,
      result: {
        paths: yield* globalApp.paths,
        dist,
        userLandofileCreated: user.created,
      } satisfies GlobalInstallResult,
    };
  },
  (effect, _options: GlobalInstallOptions = {}) => withGlobalMutation(effect),
);

export const globalInstall = Effect.fn("AppOperation.reconcileGlobalConfiguration")(
  (options: GlobalInstallOptions = {}) =>
    installPreparedConfiguration(options).pipe(Effect.map(({ result }) => result)),
);

export const installAndLoadGlobalPlan = Effect.fn("GlobalApp.installAndLoadPlan")(
  function* (options: GlobalInstallOptions = {}) {
    const { candidate } = yield* installPreparedConfiguration(options);
    const provider = yield* (yield* RuntimeProviderRegistry).select(candidate.landofile.document.provider);
    if (canonicalJson(provider.capabilities) !== canonicalJson(candidate.providerCapabilities))
      return yield* Effect.fail(
        new GlobalAppError({
          operation: "loadPlan",
          message: "Provider capabilities changed after global configuration preparation.",
          remediation: "Retry explicitly to prepare and validate the current provider configuration.",
        }),
      );
    const planner = yield* AppPlanner;
    const plan = yield* withProcessCwd(candidate.paths.root, () =>
      planner.plan(candidate.landofile, provider.capabilities),
    );
    return { materialized: true as const, paths: candidate.paths, landofile: candidate.landofile, plan };
  },
  (effect, _options: GlobalInstallOptions = {}) => withGlobalMutation(effect),
);
