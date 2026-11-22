import type { LandofileLoadFailure, LandofileValidationError } from "@lando/sdk/errors";
import { type LogSource, ServiceName, type ValidationIssuePath } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { loadTopLevelEnvFiles } from "./env-files.ts";
import {
  type ServiceCredsScope,
  orderServicesByCredsReferences,
  serviceScopeContext,
} from "./landofile-scopes.ts";
import { normalizeAppSlug } from "./naming.ts";
import { type PlannerIssue, attributePlannerIssue, expressionPlannerIssue } from "./resolved-validation.ts";
import { validateServiceSeed } from "./seed-validation.ts";
import { serviceExpressionFacts } from "./service-credential-facts.ts";
import { type ResolvedServiceSeed, type ServiceSeedInput, resolveSeed } from "./service-seed.ts";

export type { ResolvedServiceSeed };

export interface PlanningUnavailableSite {
  readonly path: ValidationIssuePath;
  readonly failure: LandofileLoadFailure;
}

export const resolveServiceSeeds = Effect.fn("AppPlanner.resolveServices")(function* (
  input: ServiceSeedInput,
) {
  const { landofile, fileSystem, appRoot } = input;
  const appSlug =
    input.nativeDataSlug ?? normalizeAppSlug(input.dataName ?? landofile.name ?? "app", appRoot);
  const issues: PlannerIssue[] = [];
  const record = (error: LandofileValidationError) => {
    const attributed = error.issues.map((issue) =>
      attributePlannerIssue(input.provenance, { ...issue, rule: "landofile.service" }),
    );
    issues.push(...attributed);
    return attributed;
  };
  const loadedTopLevelEnvFiles = yield* loadTopLevelEnvFiles({
    appRoot,
    envFiles: landofile.serviceDefaults?.env_file ?? [],
    fileSystem,
  }).pipe(Effect.result);
  if (Result.isFailure(loadedTopLevelEnvFiles)) record(loadedTopLevelEnvFiles.failure);
  const topLevelEnvFiles = Result.isSuccess(loadedTopLevelEnvFiles)
    ? loadedTopLevelEnvFiles.success
    : { environment: {}, inputs: [] };
  // URL descriptors exist independently of service resolution; credentials do not.
  const serviceCredsScope: Record<string, ServiceCredsScope[string]> = Object.fromEntries(
    Object.keys(landofile.services ?? {}).map((name) => [name, serviceExpressionFacts(name)]),
  );
  let pendingSites = input.deferredSites;
  const documents = { ...landofile.services };
  const resolvedByName = new Map<
    string,
    ResolvedServiceSeed & { readonly logSources: readonly LogSource[] }
  >();
  const unavailable = new Map<string, readonly PlannerIssue[]>();
  const skippedServices = new Map<string, PlannerIssue>();
  for (const site of input.unavailableSites ?? []) {
    const [section, name] = site.path;
    if ((section !== "services" && section !== "proxy") || typeof name !== "string") continue;
    if (landofile.services?.[ServiceName.make(name)] === undefined) continue;
    const reason: PlannerIssue = {
      path: site.path,
      rule: "landofile.load",
      message: site.failure.message,
      suggestion: site.failure.remediation,
    };
    unavailable.set(name, [...(unavailable.get(name) ?? []), reason]);
  }
  const order = yield* orderServicesByCredsReferences({
    landofile,
    deferredSites: input.deferredSites.filter(
      ({ path }) => path[0] !== "services" || typeof path[1] !== "string" || !unavailable.has(path[1]),
    ),
    landofilePath: input.landofilePath,
    pluginRegistry: input.pluginRegistry,
    registeredServiceTypeIds: input.registeredServiceTypeIds,
  });
  for (const name of order.order) {
    if (unavailable.has(name)) continue;
    const causes = [
      ...new Set(
        [...(order.references.get(name)?.keys() ?? [])].flatMap((ref) => unavailable.get(ref) ?? []),
      ),
    ];
    if (causes.length > 0) {
      unavailable.set(name, causes);
      const expression = causes.find(({ rule }) => rule === "landofile.expression");
      if (expression !== undefined) skippedServices.set(name, expression);
      continue;
    }
    const key = ServiceName.make(name);
    const service = landofile.services?.[key];
    if (service === undefined) continue;
    const context = serviceScopeContext({ ...input, services: serviceCredsScope });
    const resolved = yield* resolveSeed(input, topLevelEnvFiles, {
      name,
      service,
      sites: pendingSites,
      context,
    }).pipe(
      Effect.map((seed) => ({ _tag: "Resolved" as const, seed })),
      Effect.catchTag(["LandofileValidationError", "ConfigExpressionError"], (error) =>
        error._tag === "LandofileValidationError" || input.mode === "diagnostic"
          ? Effect.succeed({ _tag: "Unavailable" as const, error })
          : Effect.fail(error),
      ),
    );
    if (resolved._tag === "Unavailable") {
      switch (resolved.error._tag) {
        case "ConfigExpressionError": {
          const issue = attributePlannerIssue(input.provenance, expressionPlannerIssue(resolved.error));
          issues.push(issue);
          unavailable.set(name, [issue]);
          break;
        }
        case "LandofileValidationError":
          unavailable.set(name, record(resolved.error));
          break;
      }
      continue;
    }
    const { seed } = resolved;
    const checked = yield* validateServiceSeed(
      seed,
      { appRoot, appSlug, serviceName: name, configs: landofile.configs },
      input.landofilePath,
    );
    for (const error of checked.errors) record(error);
    documents[key] = seed.authoredService;
    pendingSites = pendingSites.filter(({ path }) => path[0] !== "services" || path[1] !== name);
    serviceCredsScope[name] = serviceExpressionFacts(name, seed.resolution);
    resolvedByName.set(name, { ...seed, logSources: checked.logSources });
  }
  const services = Object.keys(landofile.services ?? {}).flatMap((name) => {
    const seed = resolvedByName.get(name);
    return seed === undefined ? [] : [seed];
  });
  return {
    services,
    topLevelEnvFiles,
    serviceCredsScope,
    issues,
    unavailable,
    skippedServices,
    document: { ...landofile, services: documents },
    pendingSites,
    context: input.context,
  };
});
