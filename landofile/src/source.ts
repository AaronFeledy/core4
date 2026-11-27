import { dirname } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileParseError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { captureCompilationContext, sourceCarrier } from "./compilation.ts";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { emptyEnvironmentDependencies, recordEnvironment } from "./environment-dependencies.ts";
import { type LegacyFailureSource, legacyLoadFailure } from "./legacy-load-failure.ts";
import type { LandofileLoadContext } from "./load-context.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { parseLandofile } from "./parser.ts";
import { checkDocumentData } from "./pipeline/data.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import {
  type AuthoredDocument,
  type LandofileProvenance,
  type SourceDocument,
  emptyProvenance,
  normalizeReferencedFiles,
} from "./provenance.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";
import { buildTemplateEngineRegistry, renderLandofileTemplate } from "./template-render.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { loadLandofileTs } from "./ts-loader.ts";
import { validationErrorFromCause } from "./validation.ts";

export const readFileContent = (filePath: string): Effect.Effect<string, LandofileParseError> =>
  Effect.tryPromise({
    try: async () => Bun.file(filePath).text(),
    catch: (cause) =>
      new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Failed to read ${filePath}`,
        filePath,
        line: undefined,
        column: undefined,
        remediation: `Ensure ${filePath} exists and is readable.`,
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
      parseLandofile({ file: source.sourceFile, content: rendered, cwd: dirname(source.sourceFile) }).pipe(
        Effect.catchTag("LandofileParseError", (error) => legacyLoadFailure(error, content, source)),
      ),
    ),
  );

export const prepareLandofileSource = Effect.fn("Landofile.prepareSource")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates"> & {
    readonly sourceReplacement?: { readonly content: string } | undefined;
  },
) {
  const appRoot = context?.appRoot ?? dirname(filePath);
  const capturedEnv = hostExpressionEnvironment(
    context?.compilationContext?.env ?? inputs?.templates.context?.env,
  );
  const environmentRecorder = context?.environmentRecorder ?? recordEnvironment(capturedEnv);
  const resolvedContext: LandofileLoadContext = {
    ...(context ?? {
      appRoot,
      layer: "canonical" as const,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    }),
    pendingSites: context?.pendingSites ?? [],
    compilationContext: context?.compilationContext ?? captureCompilationContext(appRoot, capturedEnv),
    environmentRecorder,
  };
  const content = inputs?.sourceReplacement?.content ?? (yield* readFileContent(filePath));
  const form = filePath.endsWith(".ts") ? ("typescript" as const) : ("yaml" as const);
  const templateContext = inputs?.templates.context;
  const parsed = yield* form === "typescript"
    ? loadLandofileTs({
        filePath,
        appRoot: resolvedContext.appRoot,
        content,
        env: capturedEnv,
        environmentRecorder,
        ...(resolvedContext.contained === true ? { contained: true } : {}),
      })
    : parseLandofileSource({ ...resolvedContext, sourceFile: filePath }, content, {
        templates: {
          modules: inputs?.templates.modules ?? [],
          context: {
            ...(templateContext ?? {
              bootstrapLevel: "app" as const,
              scope: "landofile",
            }),
            env: environmentRecorder.view as Readonly<Record<string, string>>,
          },
        },
      });
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
  const envView =
    context.environmentRecorder === undefined
      ? context.compilationContext?.env
      : (context.environmentRecorder.view as Readonly<Record<string, string>>);
  const value = yield* parseLandofileSource({ ...context, sourceFile: filePath }, content, {
    templates: {
      modules: [],
      ...(envView === undefined
        ? {}
        : {
            context: {
              bootstrapLevel: "app" as const,
              env: envView,
              scope: "landofile",
            },
          }),
    },
  });
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
    readonly provenance?: LandofileProvenance | undefined;
  },
>(source: S) {
  const { file, value, content, context } = source;
  const { value: _authored, ...rest } = source;
  yield* checkDocumentData(value, { file, layer: context.layer });
  const resolved = yield* resolveLandofileLoadExpressions({
    value,
    source: { appRoot: context.appRoot, sourcePath: file, sourceRoot: dirname(file), layer: context.layer },
    policy: context.policy,
    pendingSites: context.pendingSites,
    recorder: context.recorder,
    environmentRecorder: context.environmentRecorder,
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
  const documents: readonly SourceDocument[] =
    content === undefined
      ? (source.provenance?.documents ?? [])
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
  const document: AuthoredDocument = {
    value: prepared.value,
    provenance: {
      ...emptyProvenance(prepared.origins),
      ...(source.provenance ?? {}),
      origins: prepared.origins,
      documents: [
        ...documents,
        ...(source.provenance?.documents ?? []).filter((d) => !documents.includes(d)),
      ],
      referencedFiles: normalizeReferencedFiles([
        ...(source.provenance?.referencedFiles ?? []),
        ...resolved.dependencies,
      ]),
      environmentDependencies:
        context.environmentRecorder?.dependencies() ??
        source.provenance?.environmentDependencies ??
        emptyEnvironmentDependencies(),
    },
  };
  return {
    ...rest,
    value: document,
    pendingSites: resolved.pendingSites,
    dependencies: resolved.dependencies,
    compiled: yield* Effect.try({
      try: () =>
        sourceCarrier({
          document: document.value,
          provenance: document.provenance,
          pendingSites: resolved.pendingSites,
          context: context.compilationContext ?? captureCompilationContext(context.appRoot),
        }),
      catch: (cause) => validationErrorFromCause(file, document.value, cause),
    }),
  };
});

export const prepareLandofileValue = Effect.fnUntraced(function* <
  S extends {
    readonly file: string;
    readonly value: unknown;
    readonly content?: string;
    readonly context: LandofileLoadContext;
  },
>(source: S) {
  const check = rejectUnsupportedToolingFeatures(source.file, source.value).pipe(
    Effect.flatMap((value) => rejectComposeKeys(source.file, value)),
  );
  if (source.context.recorder === undefined) yield* check;
  else source.context.recorder.effectiveChecks.push(check);
  return yield* resolveLandofileSourceExpressions(source);
});

export const prepareLandofileLayer = Effect.fn("Landofile.prepareLayer")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates">,
) {
  const source = yield* prepareLandofileSource(filePath, context, inputs);
  return yield* prepareLandofileValue(source);
});
