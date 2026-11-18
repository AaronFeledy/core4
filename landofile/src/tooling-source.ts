import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import {
  type ComposeKeyRejectedError,
  LandofileIncludeError,
  type LandofileLoadError,
  type LandofileLoadFailure,
  type LandofileParseError,
  type LandofileValidationError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import { isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { type LandofileLayer, type LandofileShape, ToolingTaskInput } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { materializeIncludeConditions } from "./include-conditions.ts";
import type { LandofileRelaxedRead } from "./include-context.ts";
import { assertUnderRoot } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { includeReadError } from "./include-read-error.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
import type { LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import { parseLandofile } from "./parser.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import {
  type AuthoredDocument,
  type LandofileReferencedFile,
  type SourceDocument,
  emptyProvenance,
  normalizeReferencedFiles,
} from "./provenance.ts";
import { assertToolingFragment } from "./tooling-fragment.ts";
import type { NormalizedToolingInclude } from "./tooling-include-entries.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { validationErrorFromCause } from "./validation.ts";

export type ToolingIncludeError =
  | LandofileLoadFailure
  | LandofileLoadError
  | import("@lando/sdk/errors").ConfigExpressionError
  | ComposeKeyRejectedError
  | LandofileIncludeError
  | LandofileParseError
  | LandofileValidationError
  | ResolveLandofileLoadExpressionError
  | NotImplementedError;
interface ToolingFragment {
  readonly filePath: string;
  readonly tooling: unknown;
  readonly document: AuthoredDocument;
  readonly nested: Pick<LandofileShape, "includes" | "toolingIncludes">;
  readonly referencedFiles: readonly LandofileReferencedFile[];
}

export interface ToolingSourceContext {
  readonly recorder?: LoadFailureRecorder | undefined;
  readonly layer?: LandofileLayer;
  readonly appRoot: string;
  readonly loadScope: LandofileLoadScope;
  readonly loadPolicy: LandofileLoadPolicy;
  readonly onRelaxedRead?: ((read: LandofileRelaxedRead) => Effect.Effect<void>) | undefined;
}
const ToolingWire = Schema.Struct({
  tooling: Schema.optionalKey(Schema.Record(Schema.String, Schema.toEncoded(ToolingTaskInput))),
});
const readFragmentText = (filePath: string, source: string): Effect.Effect<string, LandofileIncludeError> =>
  Effect.tryPromise({
    try: () => Bun.file(filePath).text(),
    catch: (cause) => includeReadError(filePath, source, cause),
  });
export const locateFragment = (
  entry: NormalizedToolingInclude,
  appRoot: string,
  sourceRoot: string,
): Effect.Effect<string | undefined, LandofileIncludeError> =>
  Effect.tryPromise({
    try: async (): Promise<string | undefined> => {
      const candidate = isAbsolute(entry.source) ? entry.source : resolve(sourceRoot, entry.source);
      const contained = await assertUnderRoot(appRoot, candidate, entry.source);
      const found = await stat(contained).catch((cause: unknown) => {
        if (entry.optional && cause instanceof Error && "code" in cause && cause.code === "ENOENT")
          return undefined;
        throw includeReadError(contained, entry.source, cause);
      });
      return found === undefined ? undefined : contained;
    },
    catch: (cause) =>
      cause instanceof LandofileIncludeError
        ? cause
        : includeReadError(resolve(sourceRoot, entry.source), entry.source, cause),
  });
export const loadFragment = Effect.fnUntraced(function* (
  entry: NormalizedToolingInclude,
  filePath: string,
  context: ToolingSourceContext,
) {
  const layer = context.layer ?? "canonical";
  const content = yield* readFragmentText(filePath, entry.source);
  const parsed = yield* parseLandofile({ file: filePath, content, cwd: dirname(filePath) });
  const documents: readonly SourceDocument[] = isPlainRecord(parsed)
    ? [
        {
          file: filePath,
          layer,
          form: "yaml",
          content,
          digest: sha256Hex(content),
          document: parsed,
        },
      ]
    : [];
  yield* assertToolingFragment(isPlainRecord(parsed) ? mergeLandofiles([parsed]) : parsed, entry.source, {
    filePath,
    layer,
    recorder: context.recorder,
  });
  const check = rejectComposeKeys(entry.source, parsed).pipe(
    Effect.flatMap(() => rejectUnsupportedToolingFeatures(filePath, parsed)),
  );
  if (context.recorder === undefined) yield* check;
  else context.recorder.effectiveChecks.push(check);
  const resolved = yield* resolveLandofileLoadExpressions({
    value: parsed,
    source: {
      appRoot: context.appRoot,
      sourcePath: filePath,
      sourceRoot: dirname(filePath),
      layer,
    },
    policy: context.loadPolicy,
    pendingSites: context.loadScope.pendingSites,
    recorder: context.recorder,
    environmentRecorder: context.loadScope.environmentRecorder,
  });
  const onRelaxedRead = context.onRelaxedRead;
  if (onRelaxedRead !== undefined)
    yield* Effect.forEach(resolved.relaxedReads, (read) =>
      onRelaxedRead({ ...read, sourcePath: filePath, appRoot: context.appRoot }),
    ).pipe(Effect.asVoid);
  const prepared = yield* prepareOverlay(
    resolved.value,
    { file: filePath, layer },
    documents[0]?.document ?? resolved.value,
  );
  const documented: AuthoredDocument = {
    value: prepared.value,
    provenance: {
      ...emptyProvenance(prepared.origins),
      documents,
      referencedFiles: normalizeReferencedFiles(resolved.dependencies),
    },
  };
  const conditioned = yield* materializeIncludeConditions(documented, {
    source: { sourcePath: filePath, sourceRoot: dirname(filePath), appRoot: context.appRoot, layer },
    policy: context.loadPolicy,
    scope: context.loadScope,
    ...(context.onRelaxedRead === undefined ? {} : { onRelaxedRead: context.onRelaxedRead }),
  });
  const materialized = yield* materializeLandofileLayer(filePath, conditioned, context.loadScope);
  yield* assertToolingFragment(mergeLandofiles([materialized.value]), entry.source, {
    filePath,
    layer,
    recorder: context.recorder,
  });
  if (!context.recorder?.blocked.some((source) => "file" in source && source.file === filePath))
    yield* Schema.decodeUnknownEffect(ToolingWire)(mergeLandofiles([materialized.value]), {
      errors: "all",
    }).pipe(mapFailures((cause) => validationErrorFromCause(filePath, materialized.value, cause)));
  const acquired =
    context.recorder === undefined
      ? materialized
      : prepareIncludeAcquisition(materialized, {
          recorder: context.recorder,
          source: { file: filePath, layer, path: [] },
        });
  return {
    filePath,
    tooling: materialized.value.tooling,
    document: acquired,
    nested: includeAcquisitionView(acquired.value),
    referencedFiles: normalizeReferencedFiles(resolved.dependencies),
  } satisfies ToolingFragment;
});
