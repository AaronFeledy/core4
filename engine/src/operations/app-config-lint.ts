import { dirname } from "node:path";
import {
  type LintLandofileOptions,
  attributeEffectiveLintIssue,
  mergeLintFindings,
} from "@lando/landofile/lint";
import { provenanceOf } from "@lando/landofile/provenance";
import { getLandofileValueSource } from "@lando/landofile/validation";
import { normalizeHostPlatform } from "@lando/paths";
import type {
  AppDataIdentityError,
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import type {
  AppPlan,
  ConfigLintResult,
  ConfigLintViolation,
  ProviderId,
  ValidationIssue,
} from "@lando/sdk/schema";
import { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { resolveAppIdentity } from "../planner/app-identity.ts";
import { planApp } from "../planner/assemble.ts";
import { providerAlternatives } from "../planner/compose-capabilities.ts";
import { readAppDataIdentity } from "../planner/data-identity.ts";
import { invocationSitesOf, resolveLandofileForPlanning } from "../planner/event-set.ts";
import { hostShellIssues } from "../planner/host-shell-issues.ts";
import { configExpressionIssuePath } from "../planner/landofile-scopes.ts";
import { lintCapabilityIssues } from "../planner/lint-capabilities.ts";
import { planningLintFindings } from "../planner/lint-planning.ts";
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
  const scriptFindings = yield* lintBunShellScripts(snapshot.landofilePath, snapshot.resolved);
  const violations = mergeLintFindings([...snapshot.result.violations, ...scriptFindings]);
  const result = {
    ...snapshot.result,
    violations,
    valid: !violations.some((issue) => issue.severity === "error"),
  };
  if (snapshot.resolved === undefined) return result;
  const landofile = snapshot.resolved;
  const pluginRegistry = yield* PluginRegistry;
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = yield* snapshotLintFileSystem(
    Option.getOrUndefined(yield* Effect.serviceOption(FileSystem)),
  );
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const identity = yield* resolveAppIdentity(dirname(snapshot.landofilePath));
  const record = yield* readAppDataIdentity(identity);
  const dataName = record?.name ?? landofile.document.name ?? "app";
  const resolved = yield* resolveLandofileForPlanning({
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
  }).pipe(Effect.result);
  const envFindings = yield* lintEnvFiles(
    Result.isSuccess(resolved) ? resolved.success.resolution.compiled : landofile,
    snapshot.landofilePath,
    fileSystem,
    landofile.document,
  );
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "ConfigExpressionError") {
      const path = configExpressionIssuePath(resolved.failure);
      const source = getLandofileValueSource(provenanceOf(landofile), path);
      return {
        ...result,
        valid: false,
        violations: mergeLintFindings([
          ...result.violations,
          ...envFindings,
          {
            rule: "landofile.expression",
            severity: "error",
            path,
            message: resolved.failure.message,
            scopes: ["effective"],
            ...(source === undefined ? {} : { source }),
          },
        ]),
      };
    }
    return yield* Effect.fail(resolved.failure);
  }
  const resolution = resolved.success.resolution;
  // If invocation sites fail to compile, treat every pending site as unresolved so its command is not scanned.
  const invocationSites = yield* invocationSitesOf(resolution).pipe(
    Effect.orElseSucceed(() => resolution.pendingSites),
  );
  const issues = [
    ...(resolved.success._tag === "Invalid" ? resolved.success.issues : []),
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
  ];
  const evaluated = issues
    .filter(
      (issue) =>
        !envFindings.some(
          (finding) =>
            finding.severity === "error" && JSON.stringify(finding.path) === JSON.stringify(issue.path),
        ),
    )
    .map((issue) => attributeEffectiveLintIssue(landofile, issue));
  const earlier = [...result.violations, ...envFindings, ...evaluated];
  const planningFindings: ConfigLintViolation[] = [];
  if (!earlier.some((issue) => issue.severity === "error") && resolution.capabilities !== undefined) {
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
  }
  const finalViolations = mergeLintFindings([...earlier, ...planningFindings]);
  return {
    ...result,
    file:
      sourceFile(finalViolations.find((issue) => issue.source?.layer !== "script")?.source) ?? result.file,
    valid: !finalViolations.some((issue) => issue.severity === "error"),
    violations: finalViolations,
  };
});
