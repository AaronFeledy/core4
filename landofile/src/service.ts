import { dirname, join } from "node:path";

import { Cause, type Context, Effect, Layer, ParseResult } from "effect";

import {
  type ComposeKeyRejectedError,
  LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  LandofileUnknownEventError,
  LandofileValidationError,
  NotImplementedError,
  type ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import { type LandofileLayer, LandofileShape, ServiceConfig } from "@lando/sdk/schema";
import { ConfigService, LandofileService, Logger } from "@lando/sdk/services";

import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { rejectComposeKeys, rejectComposeTags } from "./compose/rejections.ts";
import { decodeOrFail } from "./decode.ts";
import { LANDOFILE_NAME } from "./discovery.ts";
import { VALID_APP_LIFECYCLE_EVENTS, unknownAppLifecycleEvent } from "./events.ts";
import { getLocalIncludePaths, rememberLocalIncludePaths } from "./include-provenance.ts";
import { type LandofileRelaxedRead, resolveLandofileIncludes } from "./includes.ts";
import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
import { mergeLandofiles } from "./merge.ts";
import { parseLandofile } from "./parser.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { buildTemplateEngineRegistry, renderLandofileTemplate } from "./template-render.ts";
import { BETA_REMEDIATION, rejectBetaToolingFeatures } from "./tooling-beta.ts";
import { composeToolingIncludeEntries } from "./tooling-include-entries.ts";
import { loadLandofileTs } from "./ts-loader.ts";
import {
  getVersionConstraintEntries,
  isValidSemverRange,
  rememberVersionConstraintEntries,
} from "./version-constraint.ts";

export { LandofileService } from "@lando/sdk/services";

const REMEDIATION = "Remove unsupported keys or update the documented Landofile service schema.";
const COMPOSE_ALLOWLIST_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

const SERVICE_CONFIG_KEYS = new Set([
  ...Object.keys(ServiceConfig.fields),
  "working_dir",
  "env_file",
  "depends_on",
]);

const BETA_TOP_LEVEL_KEYS: ReadonlyArray<{
  key: string;
  description: string;
}> = [];

const rejectUnknownEventNames = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, LandofileUnknownEventError> => {
  const unknown = unknownAppLifecycleEvent(parsed);
  if (unknown === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new LandofileUnknownEventError({
      message: `Unknown app lifecycle event ${unknown}. Valid events: ${VALID_APP_LIFECYCLE_EVENTS.join(", ")}.`,
      event: unknown,
      validEvents: [...VALID_APP_LIFECYCLE_EVENTS],
      file: filePath,
      remediation: `Use one of: ${VALID_APP_LIFECYCLE_EVENTS.join(", ")}.`,
    }),
  );
};

const scanForBetaTopLevelKey = (parsed: unknown): { key: string; description: string } | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const entry of BETA_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(obj, entry.key)) return entry;
  }
  return undefined;
};

const CONFIG_EXPRESSION_PATTERN = /\$\{[A-Za-z_]/;
const TEMPLATE_EXPRESSION_PATTERN = /\{\{/;

const scanForConfigExpression = (content: string): { description: string } | undefined => {
  const withoutComments = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
  if (CONFIG_EXPRESSION_PATTERN.test(withoutComments)) {
    return { description: "Configuration expressions (${...})" };
  }
  if (TEMPLATE_EXPRESSION_PATTERN.test(withoutComments)) {
    return { description: "Template expressions ({{ ... }})" };
  }
  return undefined;
};

type LandofileForm = "yaml" | "typescript";

interface DiscoveredLandofile {
  readonly filePath: string;
  readonly form: LandofileForm;
  readonly searched: ReadonlyArray<string>;
}

const findLandofile = async (cwd: string): Promise<DiscoveredLandofile> => {
  const searched: string[] = [];
  let current = cwd;

  for (;;) {
    const candidates = landofileLayerPaths(current);
    searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
    const layer = representativeLandofileLayer(await presentLandofileLayers(current));
    if (layer !== undefined) {
      return {
        filePath: layer.filePath,
        form: layer.filePath.endsWith(".ts") ? "typescript" : "yaml",
        searched,
      };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new LandofileNotFoundError({
    message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
    cwd,
  });
};

export const findDiscoveredLandofilePath = async (
  cwd: string,
): Promise<{ readonly filePath: string; readonly appRoot: string }> => {
  const discovered = await findLandofile(cwd);
  return { filePath: discovered.filePath, appRoot: dirname(discovered.filePath) };
};

const extractFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const failure = Cause.failureOption(cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 || issue.message.startsWith("Landofile service")
        ? issue.message
        : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const unsupportedAuthoredServiceKeyTypes = (
  parsed: unknown,
): { readonly compose: number; readonly nonCompose: number } => {
  if (parsed === null || typeof parsed !== "object") return { compose: 0, nonCompose: 0 };
  const services = (parsed as { readonly services?: unknown }).services;
  if (services === null || typeof services !== "object") return { compose: 0, nonCompose: 0 };

  let compose = 0;
  let nonCompose = 0;
  for (const service of Object.values(services as Record<string, unknown>)) {
    if (service === null || typeof service !== "object") continue;
    const serviceRecord = service as Record<string, unknown>;
    const hasUnsupportedKey = Object.keys(serviceRecord).some(
      (key) => !SERVICE_CONFIG_KEYS.has(key) && !key.startsWith("x-"),
    );
    if (!hasUnsupportedKey) continue;
    if (serviceRecord.type === "compose") compose++;
    else nonCompose++;
  }
  return { compose, nonCompose };
};

const validationScope = (parsed: unknown): { readonly scope: string; readonly remediation: string } => {
  const unsupportedKeyTypes = unsupportedAuthoredServiceKeyTypes(parsed);
  if (unsupportedKeyTypes.compose > 0 && unsupportedKeyTypes.nonCompose === 0) {
    return { scope: "unsupported Compose-subset keys", remediation: COMPOSE_ALLOWLIST_REMEDIATION };
  }
  if (unsupportedKeyTypes.compose > 0 && unsupportedKeyTypes.nonCompose > 0) {
    return {
      scope: "unsupported service keys",
      remediation: `${REMEDIATION} For type: compose services, ${COMPOSE_ALLOWLIST_REMEDIATION}`,
    };
  }
  return { scope: "unsupported MVP keys", remediation: REMEDIATION };
};

const validateLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<typeof LandofileShape.Type, LandofileValidationError | LandofileParseError> => {
  const authoredRange =
    parsed !== null && typeof parsed === "object" && "lando" in parsed
      ? (parsed as { readonly lando?: unknown }).lando
      : undefined;
  if (typeof authoredRange === "string" && !isValidSemverRange(authoredRange)) {
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${authoredRange}". Use npm semver syntax such as ">=4.1 <5", "^4", or "4.x".`,
        filePath,
        line: undefined,
        column: undefined,
      }),
    );
  }
  return decodeOrFail(LandofileShape, (cause) => {
    const issues = validationIssues(cause);
    const { scope, remediation } = validationScope(parsed);
    return new LandofileValidationError({
      message: `Landofile contains ${scope}: ${issues.join(", ")}. ${remediation}`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });
};

const scanContentForBetaExpressions = (
  filePath: string,
  content: string,
): Effect.Effect<string, NotImplementedError> => {
  const match = scanForConfigExpression(content);
  if (match === undefined) return Effect.succeed(content);
  if (content.includes("load(") || content.includes("import(")) return Effect.succeed(content);
  return Effect.fail(
    new NotImplementedError({
      message: `${match.description} are not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};

const rejectBetaTopLevelKeys = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const beta = scanForBetaTopLevelKey(parsed);
  if (beta === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: `Top-level "${beta.key}:" is not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};

type LandofileLoadError =
  | ComposeKeyRejectedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileUnknownEventError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ResolveLandofileLoadExpressionError
  | NotImplementedError
  | ToolingIncludeCycleError;

interface LandofileLoadContext {
  readonly appRoot: string;
  readonly layer: LandofileLayer;
  readonly policy: LandofileLoadPolicy;
  readonly logger?: Context.Tag.Service<typeof Logger> | undefined;
}

const loadContext = (
  appRoot: string,
): Effect.Effect<Omit<LandofileLoadContext, "layer">, LandofileParseError> =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ConfigService);
    const logger = yield* Effect.serviceOption(Logger);
    const policy =
      config._tag === "None"
        ? DEFAULT_LANDOFILE_LOAD_POLICY
        : yield* config.value.load.pipe(
            Effect.map((value) => ({
              allowOutsideRoot: value.allowLoadOutsideRoot,
              maxFileBytes: value.loadMaxFileBytes,
              maxFilesPerExpression: value.loadMaxFilesPerExpression,
              maxRecursionDepth: value.loadMaxRecursionDepth,
            })),
            Effect.mapError(
              (cause) =>
                new LandofileParseError({
                  message: "Global configuration could not be loaded for Landofile expressions.",
                  filePath: appRoot,
                  line: undefined,
                  column: undefined,
                  cause,
                }),
            ),
          );
    return { appRoot, policy, ...(logger._tag === "Some" ? { logger: logger.value } : {}) };
  });

export const loadLandofileFile = (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
): Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> =>
  Effect.gen(function* () {
    const resolvedContext = context ?? {
      appRoot: dirname(filePath),
      layer: "canonical" as const,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    };
    const parsed = yield* filePath.endsWith(".ts")
      ? loadTsLandofile(filePath)
      : loadYamlLandofile(filePath, inputs);
    const resolved = yield* resolveLandofileLoadExpressions({
      value: parsed,
      source: {
        appRoot: resolvedContext.appRoot,
        sourcePath: filePath,
        sourceRoot: dirname(filePath),
        layer: resolvedContext.layer,
      },
      policy: resolvedContext.policy,
    });
    if (resolvedContext.logger !== undefined) {
      const logger = resolvedContext.logger;
      yield* Effect.forEach(resolved.relaxedReads, (read) =>
        logger
          .info("Landofile load used outside-root policy override", {
            sourcePath: filePath,
            authoredPath: read.authoredPath,
            absolutePath: read.absolutePath,
            appRoot: resolvedContext.appRoot,
          })
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }
    const landofile = yield* validateLandofile(filePath, resolved.value);
    return rememberLandofileAppRoot(
      rememberLandofileReferencedFiles(landofile, resolved.dependencies),
      resolvedContext.appRoot,
    );
  });

const readFileContent = (filePath: string): Effect.Effect<string, LandofileParseError> =>
  Effect.tryPromise({
    try: async () => Bun.file(filePath).text(),
    catch: (cause) =>
      new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Failed to read ${filePath}`,
        filePath,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

const loadYamlLandofile = (
  filePath: string,
  inputs: LandofileRuntimeInputs | undefined,
): Effect.Effect<
  unknown,
  ComposeKeyRejectedError | LandofileParseError | LandofileUnknownEventError | NotImplementedError
> =>
  readFileContent(filePath).pipe(
    Effect.flatMap((content) =>
      renderLandofileTemplate({
        filePath,
        content,
        registry: buildTemplateEngineRegistry(inputs?.templates.modules ?? []),
        ...(inputs?.templates.context === undefined ? {} : { context: inputs.templates.context }),
      }),
    ),
    Effect.flatMap((content) => scanContentForBetaExpressions(filePath, content)),
    Effect.flatMap((content) => rejectComposeTags(filePath, content)),
    Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
    Effect.flatMap((parsed) => rejectBetaTopLevelKeys(filePath, parsed)),
    Effect.flatMap((parsed) => rejectUnknownEventNames(filePath, parsed)),
    Effect.flatMap((parsed) => rejectBetaToolingFeatures(filePath, parsed)),
    Effect.flatMap((parsed) => rejectComposeKeys(filePath, parsed)),
  );

const loadTsLandofile = (
  filePath: string,
): Effect.Effect<
  unknown,
  | ComposeKeyRejectedError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileUnknownEventError
  | NotImplementedError
> =>
  readFileContent(filePath).pipe(
    Effect.flatMap((content) => loadLandofileTs({ filePath, appRoot: dirname(filePath), content })),
    Effect.flatMap((parsed) => rejectBetaTopLevelKeys(filePath, parsed)),
    Effect.flatMap((parsed) => rejectUnknownEventNames(filePath, parsed)),
    Effect.flatMap((parsed) => rejectBetaToolingFeatures(filePath, parsed)),
    Effect.flatMap((parsed) => rejectComposeKeys(filePath, parsed)),
  );

export const loadLandofileLayers = (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs,
): Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> =>
  Effect.gen(function* () {
    const runtime = yield* loadContext(appRoot);
    const logger = runtime.logger;
    const onRelaxedRead =
      logger === undefined
        ? undefined
        : (read: LandofileRelaxedRead) =>
            logger
              .info("Landofile load used outside-root policy override", {
                sourcePath: read.sourcePath,
                authoredPath: read.authoredPath,
                absolutePath: read.absolutePath,
                appRoot: read.appRoot,
              })
              .pipe(Effect.catchAll(() => Effect.void));
    return yield* Effect.tryPromise({
      try: () => presentLandofileLayers(appRoot),
      catch: (cause) =>
        cause instanceof LandofileFormConflictError
          ? cause
          : new LandofileParseError({
              message: cause instanceof Error ? cause.message : "Failed to enumerate Landofile layers.",
              filePath: canonicalPath,
              line: undefined,
              column: undefined,
              cause,
            }),
    }).pipe(
      Effect.flatMap((layers) =>
        Effect.forEach(layers, (layer) =>
          loadLandofileFile(layer.filePath, { ...runtime, layer: layer.layer }, inputs).pipe(
            Effect.flatMap((landofile) =>
              resolveLandofileIncludes({
                landofile,
                appRoot,
                sourcePath: layer.filePath,
                layer: layer.layer,
                order: layer.order,
                resolveTooling: false,
                loadPolicy: runtime.policy,
                ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
                ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
              }),
            ),
            Effect.map((landofile) => ({ layer, landofile })),
          ),
        ),
      ),
      Effect.flatMap((loaded) => {
        const composedTooling = composeToolingIncludeEntries(loaded.map(({ landofile }) => landofile));
        const merged = {
          ...mergeLandofiles(loaded.map(({ landofile }) => landofile as Record<string, unknown>)),
          ...(composedTooling.length === 0 ? {} : { includes: composedTooling }),
        };
        return rejectComposeKeys(canonicalPath, merged)
          .pipe(
            Effect.flatMap((parsed) => validateLandofile(canonicalPath, parsed)),
            Effect.map((landofile) =>
              rememberLandofileAppRoot(
                rememberLocalIncludePaths(
                  rememberVersionConstraintEntries(
                    landofile,
                    loaded.flatMap(({ landofile, layer }) =>
                      getVersionConstraintEntries(landofile, layer.filePath),
                    ),
                  ),
                  loaded.flatMap(({ landofile }) => getLocalIncludePaths(landofile)),
                ),
                appRoot,
              ),
            ),
            Effect.flatMap((landofile) =>
              resolveLandofileIncludes({
                landofile,
                appRoot,
                sourcePath: canonicalPath,
                loadPolicy: runtime.policy,
                ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
                ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
              }),
            ),
          )
          .pipe(
            Effect.map((landofile) =>
              rememberLandofileReferencedFiles(
                landofile,
                loaded.flatMap(({ landofile: layerLandofile }) =>
                  getLandofileReferencedFiles(layerLandofile),
                ),
              ),
            ),
          );
      }),
    );
  });

const makeDiscoverLandofile = (
  inputs: LandofileRuntimeInputs,
): Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> =>
  Effect.tryPromise({
    try: async () => findLandofile(process.cwd()),
    catch: (cause) => {
      if (cause instanceof LandofileNotFoundError) return cause;
      if (cause instanceof LandofileFormConflictError) return cause;
      if (cause instanceof LandofileParseError) return cause;
      return new LandofileParseError({
        message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
        filePath: join(process.cwd(), LANDOFILE_NAME),
        line: undefined,
        column: undefined,
        cause,
      });
    },
  }).pipe(
    Effect.flatMap(({ filePath }) => loadLandofileLayers(dirname(filePath), filePath, inputs)),
    Effect.catchAllCause((cause) => {
      const failure = extractFailure(cause);
      if (failure !== undefined) return Effect.fail(failure);
      return Effect.fail(
        new LandofileParseError({
          message: "Failed to load Landofile.",
          filePath: join(process.cwd(), LANDOFILE_NAME),
          line: undefined,
          column: undefined,
          cause,
        }),
      );
    }),
  );

export const makeLandofileServiceLive = (inputs: LandofileRuntimeInputs) =>
  Layer.succeed(LandofileService, { discover: makeDiscoverLandofile(inputs) });
