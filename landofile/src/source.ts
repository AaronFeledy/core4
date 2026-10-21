import { dirname } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileParseError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { type LegacyFailureSource, legacyLoadFailure } from "./legacy-load-failure.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { rememberLandofileReferencedFiles } from "./load-expression-provenance.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { checkDocumentData } from "./pipeline/data.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import { getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { parseSupportedLandofileSource } from "./source-scan.ts";
import { buildTemplateEngineRegistry, renderLandofileTemplate } from "./template-render.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { loadLandofileTs } from "./ts-loader.ts";

export const readFileContent = (filePath: string): Effect.Effect<string, LandofileParseError> =>
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

const parseLandofileSource = (
  source: LegacyFailureSource,
  content: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates">,
) =>
  renderLandofileTemplate({
    filePath: source.sourceFile,
    content,
    registry: buildTemplateEngineRegistry(inputs?.templates.modules ?? []),
    ...(inputs?.templates.context === undefined ? {} : { context: inputs.templates.context }),
  }).pipe(
    Effect.flatMap((rendered) =>
      parseSupportedLandofileSource(source.sourceFile, rendered).pipe(
        Effect.catchTag("LandofileParseError", (error) => legacyLoadFailure(error, content, source)),
      ),
    ),
  );

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
  const content = yield* readFileContent(filePath);
  const form = filePath.endsWith(".ts") ? ("typescript" as const) : ("yaml" as const);
  const parsed = yield* form === "typescript"
    ? loadLandofileTs({ filePath, appRoot: resolvedContext.appRoot, content })
    : parseLandofileSource({ ...resolvedContext, sourceFile: filePath }, content, inputs);
  return {
    file: filePath,
    value: parsed,
    content,
    form,
    digest: sha256Hex(content),
    context: resolvedContext,
  };
});

export const prepareLandofileContent = Effect.fn("Landofile.prepareContent")(function* (
  filePath: string,
  content: string,
  context: LandofileLoadContext,
) {
  const value = yield* parseLandofileSource({ ...context, sourceFile: filePath }, content);
  return yield* prepareLandofileValue({
    file: filePath,
    content,
    value,
    context,
    form: "yaml" as const,
    digest: sha256Hex(content),
  });
});

export const resolveLandofileSourceExpressions = Effect.fn("Landofile.resolveSourceExpressions")(function* <
  S extends {
    readonly file: string;
    readonly value: unknown;
    readonly content?: string;
    readonly context: LandofileLoadContext;
  },
>(source: S) {
  const { file, value, content, context } = source;
  yield* checkDocumentData(value, { file, layer: context.layer });
  const resolved = yield* resolveLandofileLoadExpressions({
    value,
    source: { appRoot: context.appRoot, sourcePath: file, sourceRoot: dirname(file), layer: context.layer },
    policy: context.policy,
  });
  if (context.logger !== undefined) {
    const logger = context.logger;
    yield* Effect.forEach(resolved.relaxedReads, (read) =>
      logger
        .info("Landofile load used outside-root policy override", {
          sourcePath: file,
          authoredPath: read.authoredPath,
          absolutePath: read.absolutePath,
          appRoot: context.appRoot,
        })
        .pipe(Effect.catch(() => Effect.void)),
    );
  }
  const prepared = yield* prepareOverlay(resolved.value, { file, layer: context.layer }, value);
  const document = rememberLandofileReferencedFiles(
    rememberOrigins(prepared.value, prepared.origins),
    resolved.dependencies,
  );
  const documents =
    content === undefined
      ? typeof value === "object" && value !== null
        ? getSourceDocuments(value)
        : []
      : [
          {
            file,
            layer: context.layer,
            form: file.endsWith(".ts") ? ("typescript" as const) : ("yaml" as const),
            content,
            digest: sha256Hex(content),
            document: value,
          },
        ];
  rememberSourceDocuments(document, documents);
  return { ...source, value: document, dependencies: resolved.dependencies };
});

export const prepareLandofileValue = Effect.fnUntraced(function* <
  S extends {
    readonly file: string;
    readonly value: unknown;
    readonly content?: string;
    readonly context: LandofileLoadContext;
  },
>(source: S) {
  const checked = yield* checkLandofileSource(source.file, source.value);
  return yield* resolveLandofileSourceExpressions({ ...source, value: checked });
});

const checkLandofileSource = Effect.fnUntraced(function* (file: string, value: unknown) {
  return yield* rejectUnsupportedToolingFeatures(file, value).pipe(
    Effect.flatMap((supported) => rejectComposeKeys(file, supported)),
  );
});

export const prepareLandofileLayer = Effect.fn("Landofile.prepareLayer")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  const source = yield* prepareLandofileSource(filePath, context, inputs);
  return yield* prepareLandofileValue(source);
});
