import { dirname, isAbsolute, resolve } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import {
  type ComposeKeyRejectedError,
  LandofileIncludeError,
  type LandofileParseError,
  type LandofileValidationError,
  type NotImplementedError,
  causeMessage,
} from "@lando/sdk/errors";
import { type ValueOrigins, isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { type LandofileLayer, type LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import type { LandofileRelaxedRead } from "./include-context.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import type { LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
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
  readonly layer?: LandofileLayer;
  readonly appRoot: string;
  readonly loadScope: LandofileLoadScope;
  readonly loadPolicy: LandofileLoadPolicy;
  readonly onRelaxedRead?: ((read: LandofileRelaxedRead) => Effect.Effect<void>) | undefined;
}
const MISSING_REMEDIATION = "Create the tooling fragment, fix its path, or mark the include optional: true.";
const ToolingWire = Schema.Struct({
  tooling: Schema.optionalKey(Schema.Record(Schema.String, Schema.toEncoded(ToolingTaskShape))),
});
const readFragmentText = (filePath: string, source: string): Effect.Effect<string, LandofileIncludeError> =>
  Effect.tryPromise({
    try: () => Bun.file(filePath).text(),
    catch: (cause) =>
      includeError({
        message: `Could not read tooling include ${source} at ${filePath}: ${causeMessage(cause)}`,
        source,
        kind: "fetch-failed",
      }),
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
      if (!(await Bun.file(contained).exists())) {
        if (entry.optional) return undefined;
        throw includeError({
          message: `Tooling include ${entry.source} was not found at ${candidate}.`,
          source: entry.source,
          kind: "fetch-failed",
          remediation: MISSING_REMEDIATION,
        });
      }
      return contained;
    },
    catch: (cause) =>
      cause instanceof LandofileIncludeError
        ? cause
        : includeError({ message: causeMessage(cause), source: entry.source, kind: "fetch-failed" }),
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
      assertToolingFragment(
        isPlainRecord(parsed) ? mergeLandofiles([parsed]) : parsed,
        entry.source,
        filePath,
      ),
    ),
    Effect.flatMap((parsed) => rejectComposeKeys(entry.source, parsed).pipe(Effect.as(parsed))),
    Effect.tap((parsed) => rejectUnsupportedToolingFeatures(filePath, parsed)),
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
          materializeLandofileLayer(
            filePath,
            isPlainRecord(value)
              ? copyLandofileProvenance(value, rememberOrigins(prepared.value, prepared.origins))
              : rememberOrigins(prepared.value, prepared.origins),
            context.loadScope,
          ),
        ),
        Effect.tap((materialized) =>
          assertToolingFragment(
            isPlainRecord(materialized) ? mergeLandofiles([materialized]) : materialized,
            entry.source,
            filePath,
          ),
        ),
        Effect.tap((materialized) => rejectUnsupportedToolingFeatures(filePath, materialized)),
        Effect.tap((materialized) => {
          const projection = isPlainRecord(materialized) ? mergeLandofiles([materialized]) : materialized;
          return Schema.decodeUnknownEffect(ToolingWire)(projection, { errors: "all" }).pipe(
            Effect.mapError((cause) => validationErrorFromCause(filePath, materialized, cause)),
          );
        }),
        Effect.flatMap((decoded) =>
          Effect.try({
            try: () => ({
              filePath,
              tooling: isPlainRecord(decoded) ? decoded.tooling : undefined,
              nested: includeAcquisitionView(isPlainRecord(decoded) ? decoded : {}),
              origins: getOrigins(isPlainRecord(decoded) ? decoded : {}) ?? {
                source: { file: filePath, layer: context.layer ?? "canonical", path: [] },
                deleted: false,
                children: new Map(),
              },
              sources: isPlainRecord(decoded) ? getSourceDocuments(decoded) : [],
              referencedFiles: dependencies,
            }),
            catch: (cause) => validationErrorFromCause(filePath, decoded, cause),
          }),
        ),
      ),
    ),
  );
