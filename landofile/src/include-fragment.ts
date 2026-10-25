import { sha256Hex } from "@lando/sdk/digest";
import type { LandofileIncludeError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { mergeValues } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Predicate } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import type { FragmentResult, ResolveContext, ResolveIncludesError } from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import { rememberLandofileReferencedFiles } from "./load-expression-provenance.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import { getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
  hasVersionConstraintEntries,
} from "./version-constraint.ts";

export const parseFragment = (
  fragment: FragmentResult,
  ctx: ResolveContext,
  layer: VersionConstraintEntry["layer"],
): Effect.Effect<Record<string, unknown>, ResolveIncludesError> =>
  parseLandofile({ file: fragment.filePath, content: fragment.content, cwd: fragment.root }).pipe(
    Effect.map((parsed) =>
      Predicate.isObjectOrArray(parsed)
        ? rememberSourceDocuments(parsed, [
            {
              file: fragment.filePath,
              form: "yaml",
              layer,
              document: parsed,
              content: fragment.content,
              digest: sha256Hex(fragment.content),
            },
          ])
        : parsed,
    ),
    Effect.flatMap((parsed) =>
      resolveLandofileLoadExpressions({
        value: parsed,
        source: { appRoot: ctx.appRoot, sourcePath: fragment.filePath, sourceRoot: fragment.root, layer },
        policy: fragment.userOwned ? { ...ctx.loadPolicy, allowFileAccess: false } : ctx.loadPolicy,
        pendingSites: ctx.pendingSites,
      }).pipe(
        Effect.map((resolved) => ({
          ...resolved,
          value:
            Predicate.isObjectOrArray(parsed) && Predicate.isObjectOrArray(resolved.value)
              ? copyLandofileProvenance(parsed, resolved.value)
              : resolved.value,
        })),
      ),
    ),
    Effect.tap(({ relaxedReads }) => {
      const onRelaxedRead = ctx.onRelaxedRead;
      return onRelaxedRead === undefined
        ? Effect.void
        : Effect.forEach(relaxedReads, (read) =>
            onRelaxedRead({
              sourcePath: fragment.filePath,
              authoredPath: read.authoredPath,
              absolutePath: read.absolutePath,
              appRoot: ctx.appRoot,
            }),
          ).pipe(Effect.asVoid);
    }),
    Effect.map(({ value, dependencies }) =>
      Predicate.isObjectOrArray(value) ? rememberLandofileReferencedFiles(value, dependencies) : value,
    ),
    Effect.flatMap((parsed) => rejectComposeKeys(fragment.authoredSource, parsed)),
    Effect.flatMap(
      (
        parsed,
      ): Effect.Effect<
        Record<string, unknown>,
        LandofileIncludeError | LandofileValidationError | LandofileParseError
      > => {
        if (!Predicate.isObject(parsed))
          return Effect.fail(
            includeError({
              message: `Include ${fragment.sourceId} did not parse to a Landofile object.`,
              source: fragment.sourceId,
              kind: "parse-failed",
            }),
          );
        if (
          Object.hasOwn(parsed, "name") ||
          Object.hasOwn(parsed, "runtime") ||
          Object.hasOwn(parsed, "recipe")
        )
          return Effect.fail(
            includeError({
              message: `Include ${fragment.sourceId} must not declare top-level name:, runtime:, or recipe:.`,
              source: fragment.sourceId,
              kind: "forbidden-field",
              remediation:
                "Remove top-level name:, runtime:, and recipe: from the fragment; the including Landofile owns the app's identity and recipe options.",
            }),
          );
        return prepareOverlay(
          parsed,
          { file: fragment.filePath, layer },
          getSourceDocuments(parsed)[0]?.document ?? parsed,
        ).pipe(
          Effect.map((prepared) =>
            copyLandofileProvenance(parsed, rememberOrigins(prepared.value, prepared.origins)),
          ),
        );
      },
    ),
  );

export const withoutIncludeArrays = (landofile: Record<string, unknown>): Record<string, unknown> => {
  const { include: _include, includes: _includes, ...rest } = landofile;
  return copyLandofileProvenance(landofile, rest);
};
export const withResolvedTooling = (
  landofile: Record<string, unknown>,
  included: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const { include: _include, includes: _includes, toolingIncludes: _toolingIncludes, ...inline } = landofile;
  const own = Predicate.isObject(inline.tooling) ? inline.tooling : {};
  const merged = mergeValues(LandofileShape, included, own, ["tooling"]);
  if (!Predicate.isObject(merged) || Object.keys(merged).length === 0) return inline;
  return { ...inline, tooling: merged };
};
export const ownVersionConstraintEntries = (
  landofile: { readonly lando?: string | undefined },
  source: string,
  layer: VersionConstraintEntry["layer"],
  order: VersionConstraintEntry["order"],
): ReadonlyArray<VersionConstraintEntry> => {
  // Remembered entries already name every source. The visible lando string is
  // only the raw fallback, so re-deriving it must not drop or replay them.
  if (hasVersionConstraintEntries(landofile)) return getVersionConstraintEntries(landofile, source);
  return typeof landofile.lando !== "string" ? [] : [{ range: landofile.lando, source, layer, order }];
};
