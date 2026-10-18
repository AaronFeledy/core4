import type { LandofileIncludeError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { mergeValues } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Predicate } from "effect";
import { compileLandofileLayer } from "./compile.ts";
import { rejectComposeKeys } from "./compose/rejections.ts";
import type { FragmentResult, ResolveContext, ResolveIncludesError } from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import type { VersionConstraintEntry } from "./version-constraint.ts";

export const parseFragment = (
  fragment: FragmentResult,
  ctx: ResolveContext,
  layer: VersionConstraintEntry["layer"],
): Effect.Effect<Record<string, unknown>, ResolveIncludesError> =>
  parseLandofile({ file: fragment.filePath, content: fragment.content, cwd: fragment.root }).pipe(
    Effect.flatMap((parsed) =>
      resolveLandofileLoadExpressions({
        value: parsed,
        source: { appRoot: ctx.appRoot, sourcePath: fragment.filePath, sourceRoot: fragment.root, layer },
        policy: fragment.userOwned ? { ...ctx.loadPolicy, allowFileAccess: false } : ctx.loadPolicy,
      }),
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
        return compileLandofileLayer(fragment.filePath, parsed, ctx.loadScope).pipe(
          Effect.map((decoded) =>
            rememberLandofileReferencedFiles(decoded, getLandofileReferencedFiles(parsed)),
          ),
        );
      },
    ),
  );

export const withoutIncludeArrays = (landofile: Record<string, unknown>): Record<string, unknown> => {
  const { include: _include, includes: _includes, ...rest } = landofile;
  return rest;
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
): ReadonlyArray<VersionConstraintEntry> =>
  landofile.lando === undefined ? [] : [{ range: landofile.lando, source, layer, order }];
