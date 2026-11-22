import { dirname } from "node:path";
import {
  type LintLandofileOptions,
  attributeEffectiveLintIssue,
  mergeLintFindings,
  overlapsUnavailable,
  unavailableEntrySkips,
} from "@lando/landofile/lint";
import { normalizeHostPlatform } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import type {
  AppDataIdentityError,
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import {
  type AppPlan,
  CONFIG_LINT_UNAVAILABLE_SKIP_LIMIT,
  type ConfigLintResult,
  type ConfigLintSkip,
  type ConfigLintViolation,
  LandofileLayer,
  type ProviderId,
  type ValidationIssue,
} from "@lando/sdk/schema";
import { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Option, Result, Schema } from "effect";
import { routerEnabledFrom } from "../config/router-config.ts";
import { resolveAppIdentity } from "../planner/app-identity.ts";
import { planApp } from "../planner/assemble.ts";
import { providerAlternatives } from "../planner/compose-capabilities.ts";
import { readAppDataIdentity } from "../planner/data-identity.ts";
import { invalidServiceDnsNameReason } from "../planner/dns-name-validation.ts";
import { invocationSitesOf, resolveLandofileForLint } from "../planner/event-set.ts";
import { attributePlanningFailure } from "../planner/failure-attribution.ts";
import { hostShellIssues } from "../planner/host-shell-issues.ts";
import { lintCapabilityIssues } from "../planner/lint-capabilities.ts";
import { planningLintFindings } from "../planner/lint-planning.ts";
import { expressionPlannerIssue } from "../planner/resolved-validation.ts";
import { routerTlsTerminationIssues } from "../planner/router-tls-lint.ts";
import { toolingDeclarationIssues } from "../planner/tooling-declaration-issues.ts";
import { toolingDynamicIssues } from "../planner/tooling-dynamic-issues.ts";
import { toolingAndEventIssues } from "../planner/tooling-event-issues.ts";
import { FileSyncPolicy, fileSyncMetadata, makeFileSyncPolicy } from "../plugins/file-sync-policy.ts";
import { lintLandofileSnapshot } from "../services/landofile-live.ts";
import { lintBunShellScripts } from "./app-config-lint-scripts.ts";
import { lintEnvFiles, snapshotLintFileSystem } from "./config-lint-env-files.ts";

/**
 * Reports a project user the plan deliberately did not realize. Lint stays
 * quiet for not-applicable services and for a plain unresolved identity; an
 * opt-out and an unsupported provider are choices or limits the author can act on.
 */
const projectUserLintFindings = (plan: AppPlan): ConfigLintViolation[] =>
  Object.values(plan.services).flatMap((service) => {
    const explanation = service.projectUserExplanation;
    if (explanation === undefined) return [];
    if (explanation.state !== "opted-out" && explanation.state !== "provider-unsupported") return [];
    return [
      {
        rule: "service.projectUser",
        reason: explanation.state,
        severity: "warning" as const,
        path: ["services", String(service.name), "projectUser"],
        message: explanation.detail,
        scopes: ["effective"],
        suggestion:
          explanation.state === "opted-out"
            ? "Remove projectUser: false to let Lando use the service type's project user."
            : "Files this service writes stay owned by its container identity on this provider; use a provider that maps one container id to the host user, or set projectUser: false to acknowledge it.",
      },
    ];
  });
export type AppConfigLintOptions = LintLandofileOptions;

const sourceFile = (source: ValidationIssue["source"]): string | undefined =>
  source !== undefined && "file" in source ? source.file : undefined;

const resolveSkipSource = (source: ValidationIssue["source"]): ConfigLintSkip["source"] =>
  source !== undefined && "file" in source && Schema.is(LandofileLayer)(source.layer)
    ? { file: source.file, layer: source.layer, path: source.path }
    : undefined;

const planningSkip = (
  reason: "diagnostic-document" | "earlier-errors" | "capabilities-undeclared",
): ConfigLintSkip => ({
  stage: "planning",
  reason,
  message: {
    "diagnostic-document": "Final planning did not run on a diagnostic Landofile.",
    "earlier-errors": "Final planning did not run because earlier checks reported errors.",
    "capabilities-undeclared":
      "Final planning did not run because the provider has no offline capability declaration.",
  }[reason],
});

/**
 * Config lint shared by `app:config:lint` and doctor: the load snapshot's
 * findings, resolved checks, and final planning using declared capabilities.
 * Validation planning never accesses the plan cache or issues certificates.
 */
export const appConfigLint = Effect.fn("AppOperation.configLint")(function* (
  options: AppConfigLintOptions = {},
): Effect.fn.Return<
  ConfigLintResult,
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileValidationError
  | NotImplementedError
  | AppDataIdentityError,
  PluginRegistry
> {
  const snapshot = yield* lintLandofileSnapshot(options);
  const diagnostic = snapshot.diagnostic;
  const landofile = snapshot.resolved ?? diagnostic?.landofile;
  const scriptFindings = yield* lintBunShellScripts(snapshot.landofilePath, landofile);
  const violations = mergeLintFindings([...snapshot.result.violations, ...scriptFindings]);
  const result = {
    ...snapshot.result,
    violations,
    valid: !violations.some((issue) => issue.severity === "error"),
  };
  if (landofile === undefined) {
    return result.skipped?.some((skip) => skip.reason === "load-failure")
      ? result
      : { ...result, skipped: [...(result.skipped ?? []), planningSkip("earlier-errors")] };
  }
  const unavailable = diagnostic?.unavailable ?? [];
  const pluginRegistry = yield* PluginRegistry;
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = yield* snapshotLintFileSystem(
    Option.getOrUndefined(yield* Effect.serviceOption(FileSystem)),
  );
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const identity = yield* resolveAppIdentity(dirname(snapshot.landofilePath));
  const record = yield* readAppDataIdentity(identity);
  const dataName = record?.name ?? landofile.document.name ?? "app";
  const resolved = yield* resolveLandofileForLint({
    dataName,
    landofile,
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    ...(pluginRegistry.declaredProviderCapabilities === undefined
      ? {}
      : {
          resolveCapabilities: (id: ProviderId) =>
            pluginRegistry.declaredProviderCapabilities?.(
              id,
              pathsService?.platform ?? normalizeHostPlatform(),
            ),
        }),
    file: snapshot.landofilePath,
    appRoot: dirname(snapshot.landofilePath),
    unavailableSites: unavailable,
  }).pipe(
    mapFailures((error) => attributePlanningFailure(error, { landofile, file: snapshot.landofilePath })),
    Effect.catchTag("ConfigExpressionError", (error) =>
      Effect.succeed({ _tag: "ExpressionAborted" as const, error, issues: [], dependentSkips: [] }),
    ),
  );
  const envFindings = yield* lintEnvFiles(
    resolved._tag === "ExpressionAborted" ? landofile : resolved.resolution.compiled,
    snapshot.landofilePath,
    fileSystem,
    landofile.document,
    unavailable,
  );
  const unavailableSkips = unavailableEntrySkips(
    [
      ...unavailable,
      ...resolved.dependentSkips.map(({ path, cause }) => ({
        path,
        source: resolveSkipSource(cause.source),
      })),
    ],
    CONFIG_LINT_UNAVAILABLE_SKIP_LIMIT - (resolved._tag === "ExpressionAborted" ? 1 : 0),
  );
  const priorSkips = unavailableSkips.length === 0 ? (result.skipped ?? []) : unavailableSkips;
  if (resolved._tag === "ExpressionAborted") {
    const error = attributePlanningFailure(resolved.error, { landofile, file: snapshot.landofilePath });
    const { path, filePath } = error;
    const source = resolveSkipSource(error.source);
    const pathUnavailable = overlapsUnavailable(path, unavailable);
    return {
      ...result,
      file: pathUnavailable ? result.file : filePath,
      valid: false,
      skipped: [
        ...priorSkips,
        {
          stage: "resolve",
          reason: "earlier-errors",
          path,
          ...(source === undefined ? {} : { source }),
          message: "Remaining resolve checks did not run because a configuration expression failed.",
        },
        planningSkip(diagnostic === undefined ? "earlier-errors" : "diagnostic-document"),
      ],
      violations: mergeLintFindings([
        ...result.violations,
        ...envFindings,
        ...resolved.issues
          .filter((issue) => !overlapsUnavailable(issue.path, unavailable))
          .map((issue) => attributeEffectiveLintIssue(landofile, issue)),
        ...(pathUnavailable
          ? []
          : [
              {
                ...expressionPlannerIssue(error),
                severity: "error",
                scopes: ["effective"],
              } satisfies ConfigLintViolation,
            ]),
      ]),
    };
  }
  const resolution = resolved.resolution;
  // If invocation sites fail to compile, treat every pending site as unresolved so its command is not scanned.
  const invocationSites = yield* invocationSitesOf(resolution).pipe(
    Effect.orElseSucceed(() => resolution.pendingSites),
  );
  const issues = [
    ...(resolved._tag === "Invalid" ? resolved.issues : []),
    ...toolingAndEventIssues(resolution),
    ...toolingDeclarationIssues(resolution),
    ...toolingDynamicIssues(resolution, invocationSites),
    ...hostShellIssues(resolution, invocationSites),
    ...(yield* lintCapabilityIssues(
      resolution,
      providerAlternatives(
        pluginRegistry,
        resolution.manifests,
        pathsService?.platform ?? normalizeHostPlatform(),
      ),
    )),
    ...routerTlsTerminationIssues({
      services: resolution.services,
      routes: resolution.routes,
      routerEnabled: routerEnabledFrom(resolution.globalConfig?.router, resolution.landofile.router),
    }),
  ];
  const evaluated = issues
    .filter(
      (issue) =>
        ((issue.rule === "landofile.dns-name" && issue.reason === invalidServiceDnsNameReason) ||
          !overlapsUnavailable(issue.path, unavailable)) &&
        !envFindings.some(
          (finding) =>
            finding.severity === "error" && JSON.stringify(finding.path) === JSON.stringify(issue.path),
        ),
    )
    .map((issue) => attributeEffectiveLintIssue(landofile, issue));
  const earlier = [...result.violations, ...envFindings, ...evaluated];
  const planningFindings: ConfigLintViolation[] = [];
  let skip: ConfigLintSkip | undefined;
  if (
    diagnostic === undefined &&
    !earlier.some((issue) => issue.severity === "error") &&
    resolution.capabilities !== undefined
  ) {
    const policy = makeFileSyncPolicy({
      candidates: fileSyncMetadata(resolution.manifests),
      platform: pathsService?.platform ?? normalizeHostPlatform(),
    });
    const planning = planApp({
      dataName,
      kind: "user",
      identity: { ...identity, dataName },
      landofile,
      providerCapabilities: resolution.capabilities,
      appRoot: resolution.appRoot,
      resolution,
      mode: "validate",
    }).pipe(Effect.provideService(FileSyncPolicy, policy));
    const planned = yield* (
      fileSystem === undefined ? planning : planning.pipe(Effect.provideService(FileSystem, fileSystem))
    ).pipe(Effect.result);
    if (Result.isFailure(planned))
      planningFindings.push(...planningLintFindings(resolution, planned.failure));
    else planningFindings.push(...projectUserLintFindings(planned.success));
  } else {
    skip = planningSkip(
      diagnostic !== undefined
        ? "diagnostic-document"
        : earlier.some((issue) => issue.severity === "error")
          ? "earlier-errors"
          : "capabilities-undeclared",
    );
  }
  const finalViolations = mergeLintFindings([...earlier, ...planningFindings]);
  return {
    ...result,
    file:
      sourceFile(finalViolations.find((issue) => issue.source?.layer !== "script")?.source) ?? result.file,
    valid: !finalViolations.some((issue) => issue.severity === "error"),
    violations: finalViolations,
    ...(skip === undefined ? {} : { skipped: [...priorSkips, skip] }),
  };
});
