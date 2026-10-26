import { LandofileValidationError } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { mergeLogSources } from "../services/log-sources.ts";
import { SECURITY_FEATURE_ID } from "../services/network-inject.ts";
import { CERTS_FEATURE_ID } from "../services/service-certs.ts";
import { SSH_AGENT_FEATURE_ID } from "../subsystems/ssh/api.ts";
import type { MountAuthoringContext } from "./authored-mount-entry.ts";
import { validateAuthoredMounts } from "./authored-mounts.ts";
import { validateAuthoredAppMount } from "./authored.ts";
import type { ResolvedServiceSeed } from "./service-seeds.ts";
import { authoredStorageScopes, rejectGlobalScope } from "./storage.ts";
import { validateAuthoredWebroot } from "./webroot-policy.ts";

/** These declarations are replaced by planner-owned configuration during composition. */
export const plannerSeededFeatureIds = (base: ServiceTypeResolution["base"]): ReadonlySet<string> =>
  new Set([SSH_AGENT_FEATURE_ID, ...(base === "lando" ? [SECURITY_FEATURE_ID, CERTS_FEATURE_ID] : [])]);

export const validateServiceSeed = Effect.fnUntraced(function* (
  seed: ResolvedServiceSeed,
  context: MountAuthoringContext,
  landofilePath: string,
) {
  const { appRoot } = context;
  const errors: LandofileValidationError[] = [];
  if (seed.resolution.connection !== undefined && seed.resolution.nonSqlCreds !== undefined) {
    const message = "A service type must publish either connection or nonSqlCreds, not both.";
    errors.push(
      new LandofileValidationError({
        message,
        file: landofilePath,
        remediation: "Update the service type to publish one canonical credential source.",
        issues: [validationIssue(["services", seed.name], message)],
      }),
    );
  }
  const storage = authoredStorageScopes(appRoot, seed.name, seed.resolution.normalizedConfig);
  if (storage.invalidCacheEntry !== undefined) errors.push(storage.invalidCacheEntry);
  if (storage.globalEntry !== undefined)
    yield* Effect.fail(rejectGlobalScope(appRoot, seed.name, storage.globalEntry));
  const logs = mergeLogSources({
    appRoot,
    serviceName: seed.name,
    base: seed.resolution.base,
    typeSources: seed.resolution.logSources ?? [],
    userSources: seed.authoredService.logs ?? [],
  });
  if (Result.isFailure(logs)) errors.push(logs.failure);
  const substituted = plannerSeededFeatureIds(seed.resolution.base);
  const webroot = yield* validateAuthoredWebroot(
    seed,
    seed.resolution.features.filter((ref) => !substituted.has(ref.id)),
    landofilePath,
  ).pipe(Effect.result);
  if (Result.isFailure(webroot)) errors.push(webroot.failure);
  const mount = validateAuthoredAppMount(seed.service, appRoot, seed.name);
  if (mount !== undefined) errors.push(mount);
  const mounts = validateAuthoredMounts(
    context,
    seed.resolution.normalizedConfig,
    seed.service.storage,
    seed.service.appMount,
  );
  if (mounts !== undefined) errors.push(mounts);
  return { errors, logSources: Result.isSuccess(logs) ? logs.success : [] };
});
