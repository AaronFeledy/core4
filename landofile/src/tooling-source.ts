import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
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
import { type ValueOrigins, isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { type LandofileLayer, type LandofileShape, ToolingTaskInput } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { materializeIncludeConditions } from "./include-conditions.ts";
import type { LandofileRelaxedRead } from "./include-context.ts";
import { assertUnderRoot } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { includeReadError } from "./include-read-error.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import type { LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import { parseLandofile } from "./parser.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
import { type AuthoredOrigin, prepareOverlay } from "./pipeline/prepare.ts";
import { type SourceDocument, getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
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
  readonly origins: ValueOrigins<AuthoredOrigin>;
  readonly sources: readonly SourceDocument[];
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
export const loadFragment = (
  entry: NormalizedToolingInclude,
  filePath: string,
  context: ToolingSourceContext,
): Effect.Effect<ToolingFragment, ToolingIncludeError> =>
  readFragmentText(filePath, entry.source).pipe(
    Effect.flatMap((content) =>
      parseLandofile({ file: filePath, content, cwd: dirname(filePath) }).pipe(
        Effect.map((parsed) =>
          isPlainRecord(parsed)
            ? rememberSourceDocuments(parsed, [
                {
                  file: filePath,
                  layer: context.layer ?? "canonical",
                  form: "yaml",
                  content,
                  digest: sha256Hex(content),
                  document: parsed,
                },
              ])
            : parsed,
        ),
      ),
    ),
    Effect.tap((parsed) =>
      assertToolingFragment(isPlainRecord(parsed) ? mergeLandofiles([parsed]) : parsed, entry.source, {
        filePath,
        layer: context.layer ?? "canonical",
        recorder: context.recorder,
      }),
    ),
    Effect.tap((parsed) => {
      const check = rejectComposeKeys(entry.source, parsed).pipe(
        Effect.flatMap(() => rejectUnsupportedToolingFeatures(filePath, parsed)),
      );
      if (context.recorder === undefined) return check;
      context.recorder.effectiveChecks.push(check);
      return Effect.void;
    }),
    Effect.flatMap((parsed) =>
      resolveLandofileLoadExpressions({
        value: parsed,
        source: {
          appRoot: context.appRoot,
          sourcePath: filePath,
          sourceRoot: dirname(filePath),
          layer: context.layer ?? "canonical",
        },
        policy: context.loadPolicy,
        pendingSites: context.loadScope.pendingSites,
        recorder: context.recorder,
      }).pipe(
        Effect.map((resolved) => ({
          ...resolved,
          value:
            isPlainRecord(parsed) && isPlainRecord(resolved.value)
              ? copyLandofileProvenance(parsed, resolved.value)
              : resolved.value,
        })),
      ),
    ),
    Effect.tap(({ relaxedReads }) => {
      const onRelaxedRead = context.onRelaxedRead;
      return onRelaxedRead === undefined
        ? Effect.void
        : Effect.forEach(relaxedReads, (read) =>
            onRelaxedRead({ ...read, sourcePath: filePath, appRoot: context.appRoot }),
          ).pipe(Effect.asVoid);
    }),
    Effect.flatMap(({ value, dependencies }) =>
      prepareOverlay(
        value,
        { file: filePath, layer: context.layer ?? "canonical" },
        isPlainRecord(value) ? (getSourceDocuments(value)[0]?.document ?? value) : value,
      ).pipe(
        Effect.flatMap((prepared) =>
          materializeIncludeConditions(
            isPlainRecord(value)
              ? copyLandofileProvenance(value, rememberOrigins(prepared.value, prepared.origins))
              : rememberOrigins(prepared.value, prepared.origins),
            {
              source: {
                sourcePath: filePath,
                sourceRoot: dirname(filePath),
                appRoot: context.appRoot,
                layer: context.layer ?? "canonical",
              },
              policy: context.loadPolicy,
              scope: context.loadScope,
              ...(context.onRelaxedRead === undefined ? {} : { onRelaxedRead: context.onRelaxedRead }),
            },
          ),
        ),
        Effect.flatMap((conditioned) => materializeLandofileLayer(filePath, conditioned, context.loadScope)),
        Effect.tap((materialized) =>
          assertToolingFragment(
            isPlainRecord(materialized) ? mergeLandofiles([materialized]) : materialized,
            entry.source,
            { filePath, layer: context.layer ?? "canonical", recorder: context.recorder },
          ),
        ),
        Effect.tap((materialized) => {
          if (context.recorder?.blocked.some((source) => "file" in source && source.file === filePath))
            return Effect.void;
          const projection = isPlainRecord(materialized) ? mergeLandofiles([materialized]) : materialized;
          return Schema.decodeUnknownEffect(ToolingWire)(projection, { errors: "all" }).pipe(
            Effect.mapError((cause) => validationErrorFromCause(filePath, materialized, cause)),
          );
        }),
        Effect.flatMap((decoded) =>
          Effect.try({
            try: () => {
              const document = isPlainRecord(decoded) ? decoded : {};
              const acquired =
                context.recorder === undefined
                  ? document
                  : prepareIncludeAcquisition(document, {
                      recorder: context.recorder,
                      source: { file: filePath, layer: context.layer ?? "canonical", path: [] },
                    });
              return {
                filePath,
                tooling: document.tooling,
                nested: includeAcquisitionView(acquired),
                origins: getOrigins(acquired) ?? {
                  source: { file: filePath, layer: context.layer ?? "canonical", path: [] },
                  deleted: false,
                  children: new Map(),
                },
                sources: getSourceDocuments(document),
                referencedFiles: dependencies,
              };
            },
            catch: (cause) => validationErrorFromCause(filePath, decoded, cause),
          }),
        ),
      ),
    ),
  );
