import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ComposeKeyRejectedError,
  LandofileIncludeError,
  type LandofileParseError,
  type LandofileValidationError,
  type NotImplementedError,
  type ToolingIncludeCycleError,
  causeMessage,
} from "@lando/sdk/errors";
import { type LandofileDecodedOverlay, isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  type LandofileLoadScope,
  decodeMaterializedLandofileLayer,
  materializeLandofileLayer,
} from "./compile.ts";
import { rejectComposeKeys } from "./compose/rejections.ts";
import type { LandofileRelaxedRead } from "./include-context.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";
import type { LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionError,
  resolveLandofileLoadExpressions,
} from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import { assertToolingFragment } from "./tooling-fragment.ts";
import type { NormalizedToolingInclude } from "./tooling-include-entries.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";

export type ToolingIncludeError =
  | ComposeKeyRejectedError
  | LandofileIncludeError
  | LandofileParseError
  | LandofileValidationError
  | ResolveLandofileLoadExpressionError
  | NotImplementedError
  | ToolingIncludeCycleError;
interface ToolingFragment {
  readonly filePath: string;
  readonly tooling: LandofileDecodedOverlay["tooling"];
  readonly nested: Pick<LandofileShape, "includes" | "toolingIncludes">;
  readonly referencedFiles: readonly LandofileReferencedFile[];
}

export interface ToolingSourceContext {
  readonly appRoot: string;
  readonly loadScope: LandofileLoadScope;
  readonly loadPolicy: LandofileLoadPolicy;
  readonly onRelaxedRead?: ((read: LandofileRelaxedRead) => Effect.Effect<void>) | undefined;
}
const MISSING_REMEDIATION = "Create the tooling fragment, fix its path, or mark the include optional: true.";
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
    Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
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
          layer: "canonical",
        },
        policy: context.loadPolicy,
      }),
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
      materializeLandofileLayer(filePath, value, context.loadScope).pipe(
        Effect.tap((materialized) =>
          assertToolingFragment(
            isPlainRecord(materialized) ? mergeLandofiles([materialized]) : materialized,
            entry.source,
            filePath,
          ),
        ),
        Effect.tap((materialized) => rejectUnsupportedToolingFeatures(filePath, materialized)),
        Effect.flatMap((materialized) => decodeMaterializedLandofileLayer(filePath, materialized)),
        Effect.map((decoded) => ({
          filePath,
          tooling: decoded.tooling,
          nested: mergeLandofiles([decoded]),
          referencedFiles: dependencies,
        })),
      ),
    ),
  );
