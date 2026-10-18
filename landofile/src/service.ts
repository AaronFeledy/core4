import { dirname, join } from "node:path";

import { Cause, type Context, Effect, Layer, Result } from "effect";

import {
  type ComposeKeyRejectedError,
  type Lando3LandofileDetected,
  type LandofileDialectMixError,
  LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type ManagedFileTransactionError,
  NotImplementedError,
  type ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import { expressionInterpolationsTouchOnlyScopes, parseExpressionEither } from "@lando/sdk/expressions";
import type { LandofileLayer, LandofileShape } from "@lando/sdk/schema";
import {
  ConfigService,
  LandofileService,
  Logger,
  ManagedFileTransactionGuard,
  StateStore,
} from "@lando/sdk/services";

import { type LandofileDecodedOverlay, isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { type LandofileLoadScope, buildLandofileLoadScope, compileLandofileLayer } from "./compile.ts";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { LANDOFILE_NAME } from "./discovery.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import {
  type LandofileRelaxedRead,
  resolveLandofileIncludeLayers,
  resolveLandofileIncludes,
} from "./includes.ts";
import {
  type PresentLandofileLayer,
  landofileLayerPaths,
  presentLandofileLayers,
  representativeLandofileLayer,
} from "./layers.ts";
import { type LegacyFailureSource, legacyLoadFailure } from "./legacy-load-failure.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { LOAD_DEFERRED_EXPRESSION_SCOPES, hostExpressionEnvironment } from "./recipe-expressions.ts";
import { withoutSecretReferences } from "./secret-reference.ts";
import { buildTemplateEngineRegistry, renderLandofileTemplate } from "./template-render.ts";
import { composeToolingIncludeEntries } from "./tooling-include-entries.ts";
import { UNSUPPORTED_REMEDIATION, rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { loadLandofileTs } from "./ts-loader.ts";
import { validateLandofile } from "./validation.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "./version-constraint.ts";

export { LandofileService } from "@lando/sdk/services";

const CONFIG_EXPRESSION_PATTERN = /\$\{[A-Za-z_]/;
const TEMPLATE_EXPRESSION_PATTERN = /\{\{/;
const quotedStrings = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)].map((match) => match[0]);

const isDeferredScopeTemplate = (value: string): boolean => {
  const parsed = parseExpressionEither(value, { filePath: "<landofile>" });
  return (
    Result.isSuccess(parsed) &&
    expressionInterpolationsTouchOnlyScopes(parsed.success, LOAD_DEFERRED_EXPRESSION_SCOPES)
  );
};

const scanForConfigExpression = (content: string): { description: string } | undefined => {
  const withoutComments = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
  if (CONFIG_EXPRESSION_PATTERN.test(withoutSecretReferences(withoutComments))) {
    return { description: "Configuration expressions (${...})" };
  }
  if (!TEMPLATE_EXPRESSION_PATTERN.test(withoutComments)) return undefined;

  const quoted = quotedStrings(withoutComments);
  for (const token of quoted) {
    const inner = token.slice(1, -1);
    if (inner.includes("{{") && !isDeferredScopeTemplate(inner)) {
      return { description: "Template expressions ({{ ... }})" };
    }
  }
  let remainder = withoutComments;
  for (const token of quoted) remainder = remainder.replace(token, " ");
  if (TEMPLATE_EXPRESSION_PATTERN.test(remainder)) {
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
  const failure = Cause.findErrorOption(cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const optionalTransactionGuard = Effect.fnUntraced(function* (
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard">,
) {
  if (inputs?.transactionGuard !== undefined) return inputs.transactionGuard;
  const option = yield* Effect.serviceOption(ManagedFileTransactionGuard);
  return option._tag === "Some" ? option.value : undefined;
});

const ensureConsistentRoot = Effect.fnUntraced(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard">,
) {
  const guard = yield* optionalTransactionGuard(inputs);
  if (guard !== undefined) yield* guard.ensureConsistent(appRoot);
});

const scanContentForUnsupportedExpressions = (
  filePath: string,
  content: string,
): Effect.Effect<string, NotImplementedError> => {
  const match = scanForConfigExpression(content);
  if (match === undefined) return Effect.succeed(content);
  if (content.includes("load(") || content.includes("import(")) return Effect.succeed(content);
  const unsupported = Effect.fail(
    new NotImplementedError({
      message: `${match.description} are not supported at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    }),
  );
  if (!content.includes("!reset")) return unsupported;
  // The parser discards `!reset` payloads unread, so an expression that only
  // appears there is never evaluated and must not reject the file.
  return parseLandofile({ file: filePath, content, cwd: dirname(filePath) }).pipe(
    Effect.matchEffect({
      onFailure: () => unsupported,
      onSuccess: (parsed) =>
        parsedStrings(parsed).some((value) => scanForConfigExpression(JSON.stringify(value)) !== undefined)
          ? unsupported
          : Effect.succeed(content),
    }),
  );
};

const parsedStrings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(parsedStrings);
  if (!isPlainRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...parsedStrings(entry)]);
};

type LandofileLoadError =
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | ManagedFileTransactionError
  | ComposeKeyRejectedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ResolveLandofileLoadExpressionError
  | NotImplementedError
  | ToolingIncludeCycleError;

interface LandofileLoadContext {
  readonly validCanonicalFile?: string;
  readonly appRoot: string;
  readonly layer: LandofileLayer;
  readonly policy: LandofileLoadPolicy;
  readonly logger?: Context.Service.Shape<typeof Logger> | undefined;
}

const loadContext = Effect.fnUntraced(function* (
  appRoot: string,
): Effect.fn.Return<Omit<LandofileLoadContext, "layer">, LandofileParseError> {
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

export const prepareLandofileSource = Effect.fn("Landofile.prepareSource")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  const resolvedContext = context ?? {
    appRoot: dirname(filePath),
    layer: "canonical" as const,
    policy: DEFAULT_LANDOFILE_LOAD_POLICY,
  };
  yield* ensureConsistentRoot(resolvedContext.appRoot, inputs);
  const content = filePath.endsWith(".ts") ? undefined : yield* readFileContent(filePath);
  const parsed = yield* content === undefined
    ? loadTsLandofile(filePath)
    : loadYamlLandofile({ ...resolvedContext, sourceFile: filePath }, content, inputs);
  return { file: filePath, value: parsed, content, context: resolvedContext };
});

export const resolveLandofileSourceExpressions = Effect.fn("Landofile.resolveSourceExpressions")(function* (
  source: Effect.Success<ReturnType<typeof prepareLandofileSource>>,
) {
  const { file: filePath, value: parsed, content, context: resolvedContext } = source;
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
        .pipe(Effect.catch(() => Effect.void)),
    );
  }
  return {
    file: filePath,
    value: resolved.value,
    content,
    context: resolvedContext,
    dependencies: resolved.dependencies,
  };
});

const prepareLandofileLayer = Effect.fn("Landofile.prepareLayer")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  const source = yield* prepareLandofileSource(filePath, context, inputs);
  const supported = yield* rejectUnsupportedToolingFeatures(filePath, source.value);
  const checked = yield* rejectComposeKeys(filePath, supported);
  return yield* resolveLandofileSourceExpressions({ ...source, value: checked });
});

const compilePreparedLayer: (
  prepared: Effect.Success<ReturnType<typeof prepareLandofileLayer>>,
  scope: LandofileLoadScope,
) => Effect.Effect<LandofileDecodedOverlay, LandofileLoadError> = Effect.fnUntraced(function* (
  prepared: Effect.Success<ReturnType<typeof prepareLandofileLayer>>,
  scope: LandofileLoadScope,
): Effect.fn.Return<LandofileDecodedOverlay, LandofileLoadError> {
  const { file, content, context } = prepared;
  const landofile = yield* compileLandofileLayer(file, prepared.value, scope).pipe(
    Effect.catch((error) =>
      content === undefined
        ? Effect.fail(error)
        : legacyLoadFailure(error, content, { ...context, sourceFile: file }),
    ),
  );
  return rememberLandofileAppRoot(
    rememberLandofileReferencedFiles(landofile, prepared.dependencies),
    context.appRoot,
  );
});

export const loadLandofileFile = Effect.fn("Landofile.loadFile")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
  scope?: LandofileLoadScope,
): Effect.fn.Return<typeof LandofileShape.Type, LandofileLoadError> {
  const prepared = yield* prepareLandofileLayer(filePath, context, inputs);
  const loadScope =
    scope ??
    (yield* buildLandofileLoadScope([prepared], inputs?.templates.context?.env).pipe(
      Effect.catch((error) =>
        prepared.content === undefined
          ? Effect.fail(error)
          : legacyLoadFailure(error, prepared.content, { ...prepared.context, sourceFile: filePath }),
      ),
    ));
  const overlay = yield* compilePreparedLayer(prepared, loadScope);
  const decoded = yield* validateLandofile(filePath, mergeLandofiles([overlay]));
  return rememberLandofileAppRoot(
    rememberLandofileReferencedFiles(decoded, getLandofileReferencedFiles(overlay)),
    context?.appRoot ?? dirname(filePath),
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
  source: LegacyFailureSource,
  content: string,
  inputs: Pick<LandofileRuntimeInputs, "templates"> | undefined,
): Effect.Effect<
  unknown,
  | LandofileParseError
  | LandofileValidationError
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | NotImplementedError
> => {
  const filePath = source.sourceFile;
  return Effect.succeed(content).pipe(
    Effect.flatMap((content) =>
      renderLandofileTemplate({
        filePath,
        content,
        registry: buildTemplateEngineRegistry(inputs?.templates.modules ?? []),
        ...(inputs?.templates.context === undefined ? {} : { context: inputs.templates.context }),
      }),
    ),
    Effect.flatMap((content) => scanContentForUnsupportedExpressions(filePath, content)),
    Effect.flatMap((rendered) =>
      parseLandofile({ file: filePath, content: rendered, cwd: dirname(filePath) }).pipe(
        Effect.catchTag("LandofileParseError", (error) => legacyLoadFailure(error, content, source)),
      ),
    ),
  );
};

const loadTsLandofile = (
  filePath: string,
): Effect.Effect<
  unknown,
  LandofileParseError | LandofileSandboxError | LandofileTimeoutError | NotImplementedError
> =>
  readFileContent(filePath).pipe(
    Effect.flatMap((content) => loadLandofileTs({ filePath, appRoot: dirname(filePath), content })),
  );

export const compileLandofileRootLayers = Effect.fn("Landofile.compileRootLayers")(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs,
): Effect.fn.Return<
  {
    readonly compiled: ReadonlyArray<{
      readonly layer: PresentLandofileLayer;
      readonly landofile: LandofileDecodedOverlay;
    }>;
    readonly scope: LandofileLoadScope;
    readonly runtime: Omit<LandofileLoadContext, "layer">;
  },
  LandofileLoadError
> {
  yield* ensureConsistentRoot(appRoot, inputs);
  const runtime = yield* loadContext(appRoot);
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
      Effect.gen(function* () {
        const canonical = layers.find((layer) => layer.layer === "canonical");
        const canonicalPreparation =
          canonical === undefined
            ? undefined
            : yield* prepareLandofileLayer(
                canonical.filePath,
                { ...runtime, layer: canonical.layer },
                inputs,
              ).pipe(Effect.result);
        const prepared = yield* Effect.forEach(layers, (layer) =>
          (layer === canonical && canonicalPreparation !== undefined
            ? Effect.succeed(canonicalPreparation)
            : prepareLandofileLayer(layer.filePath, { ...runtime, layer: layer.layer }, inputs).pipe(
                Effect.result,
              )
          ).pipe(Effect.map((result) => ({ result, layer }))),
        );
        const raw = prepared.flatMap(({ result, layer }) =>
          Result.isSuccess(result) ? [{ ...result.success, layer }] : [],
        );
        const env = inputs?.templates.context?.env ?? hostExpressionEnvironment();
        if (canonicalPreparation !== undefined && Result.isFailure(canonicalPreparation)) {
          return yield* Effect.fail(canonicalPreparation.failure);
        }
        const failedPreparation = prepared.find(({ result }) => Result.isFailure(result));
        if (failedPreparation !== undefined && Result.isFailure(failedPreparation.result)) {
          const error = failedPreparation.result.failure;
          if (
            (error._tag !== "LandofileParseError" && error._tag !== "LandofileValidationError") ||
            canonicalPreparation === undefined
          ) {
            return yield* Effect.fail(error);
          }
          const checkedCanonical = yield* buildLandofileLoadScope(raw, env).pipe(
            Effect.flatMap((scope) => compilePreparedLayer(canonicalPreparation.success, scope)),
            Effect.result,
          );
          if (Result.isFailure(checkedCanonical)) return yield* Effect.fail(error);
          const content = yield* readFileContent(failedPreparation.layer.filePath);
          return yield* legacyLoadFailure(error, content, {
            appRoot,
            sourceFile: failedPreparation.layer.filePath,
            validCanonicalFile: canonicalPreparation.success.file,
          });
        }
        const scope = yield* buildLandofileLoadScope(raw, env).pipe(
          Effect.catch((error) => {
            const source = raw.find(
              (source) =>
                source.file === (error._tag === "LandofileValidationError" ? error.file : error.filePath),
            );
            return source?.content === undefined
              ? Effect.fail(error)
              : legacyLoadFailure(error, source.content, { ...source.context, sourceFile: source.file });
          }),
        );
        // Validate the canonical layer once; retain precedence when consuming results.
        const canonicalResult: Result.Result<LandofileDecodedOverlay, LandofileLoadError> | undefined =
          canonicalPreparation === undefined
            ? undefined
            : yield* Effect.result(compilePreparedLayer(canonicalPreparation.success, scope));
        const validCanonicalFile =
          canonicalResult !== undefined && Result.isSuccess(canonicalResult)
            ? canonical?.filePath
            : undefined;
        const compiled = yield* Effect.forEach(raw, (preparedLayer) => {
          const layer = preparedLayer.layer;
          const context = {
            ...runtime,
            layer: layer.layer,
            ...(validCanonicalFile === undefined ? {} : { validCanonicalFile }),
          };
          return (
            layer === canonical && canonicalResult !== undefined
              ? Effect.fromResult(canonicalResult)
              : compilePreparedLayer({ ...preparedLayer, context }, scope)
          ).pipe(Effect.map((landofile) => ({ layer, landofile })));
        });
        return { compiled, scope, runtime };
      }),
    ),
  );
});

export const loadLandofileLayers = Effect.fn("Landofile.loadLayers")(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs,
): Effect.fn.Return<typeof LandofileShape.Type, LandofileLoadError> {
  const { compiled, scope, runtime } = yield* compileLandofileRootLayers(appRoot, canonicalPath, inputs);
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
            .pipe(Effect.catch(() => Effect.void));
  return yield* Effect.forEach(compiled, ({ layer, landofile }) =>
    resolveLandofileIncludeLayers({
      landofile,
      appRoot,
      sourcePath: layer.filePath,
      layer: layer.layer,
      order: layer.order,
      resolveTooling: false,
      loadPolicy: runtime.policy,
      loadScope: scope,
      ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
      ...(inputs?.stateStore === undefined ? {} : { stateStore: inputs.stateStore }),
      ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
    }).pipe(
      Effect.map((resolved) => ({ layer, landofile: resolved.provenance, overlays: resolved.overlays })),
    ),
  ).pipe(
    Effect.map((loaded) => ({ loaded, scope })),
    Effect.flatMap(({ loaded, scope }) => {
      const composedTooling = composeToolingIncludeEntries(loaded.flatMap(({ overlays }) => overlays));
      const merged = {
        ...mergeLandofiles(loaded.flatMap(({ overlays }) => overlays)),
        ...(composedTooling.length === 0 ? {} : { includes: composedTooling }),
      };
      return rejectComposeKeys(canonicalPath, merged)
        .pipe(
          Effect.flatMap((parsed) => validateLandofile(canonicalPath, parsed)),
          Effect.map((landofile) =>
            rememberLandofileAppRoot(
              rememberLandofileIncludeSources(
                rememberLocalIncludePaths(
                  rememberVersionConstraintEntries(
                    landofile,
                    loaded.flatMap(({ landofile, layer }) =>
                      getVersionConstraintEntries(landofile, layer.filePath),
                    ),
                  ),
                  loaded.flatMap(({ landofile }) => getLocalIncludePaths(landofile)),
                ),
                loaded.flatMap(({ landofile }) => getLandofileIncludeSources(landofile)),
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
              loadScope: scope,
              ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
              ...(inputs?.stateStore === undefined ? {} : { stateStore: inputs.stateStore }),
              ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
            }),
          ),
        )
        .pipe(
          Effect.map((landofile) =>
            rememberLandofileReferencedFiles(
              landofile,
              loaded.flatMap(({ landofile: layerLandofile }) => getLandofileReferencedFiles(layerLandofile)),
            ),
          ),
        );
    }),
  );
});

const makeDiscoverLandofile = Effect.fn("LandofileService.discover")(
  function* (
    inputs: LandofileRuntimeInputs,
  ): Effect.fn.Return<typeof LandofileShape.Type, LandofileLoadError> {
    const searched: string[] = [];
    let current = process.cwd();
    for (;;) {
      yield* ensureConsistentRoot(current, inputs);
      const candidates = landofileLayerPaths(current);
      searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
      const layer = yield* Effect.tryPromise({
        try: async () => representativeLandofileLayer(await presentLandofileLayers(current)),
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
      });
      if (layer !== undefined) {
        return yield* loadLandofileLayers(dirname(layer.filePath), layer.filePath, inputs);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return yield* Effect.fail(
      new LandofileNotFoundError({
        message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
        cwd: process.cwd(),
      }),
    );
  },
  Effect.catchCause((cause) => {
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

/** SDK-contract layer factory for {@link LandofileService}. */
export const layer = (inputs: LandofileRuntimeInputs) =>
  Layer.effect(
    LandofileService,
    Effect.gen(function* () {
      const transactionGuard = yield* ManagedFileTransactionGuard;
      const stateStore = yield* StateStore;
      return LandofileService.of({
        discover: makeDiscoverLandofile({ ...inputs, transactionGuard, stateStore }),
      });
    }),
  );
