import { join, relative } from "node:path";
import {
  Lando3LandofileDetected,
  LandofileDialectMixError,
  type LandofileParseError,
  type LandofileValidationError,
} from "@lando/sdk/errors";
import { Effect } from "effect";
import { hasLegacyRawKeys } from "./legacy-keys.ts";

export interface LegacyFailureSource {
  readonly appRoot: string;
  readonly sourceFile: string;
  /** Present only after the actual canonical layer passed native validation. */
  readonly validCanonicalFile?: string;
}

/** Called only for native parse/schema failures, after transaction recovery. */
export const legacyLoadFailure = (
  original: LandofileParseError | LandofileValidationError,
  content: string,
  source: LegacyFailureSource,
): Effect.Effect<
  never,
  LandofileParseError | LandofileValidationError | Lando3LandofileDetected | LandofileDialectMixError
> =>
  Effect.gen(function* () {
    const canonical = source.sourceFile === join(source.appRoot, ".lando.yml");
    if (!canonical && source.validCanonicalFile === undefined) return yield* Effect.fail(original);
    const legacy =
      hasLegacyRawKeys(content) ||
      (canonical &&
        (yield* Effect.tryPromise({
          try: () => Bun.file(join(source.appRoot, ".lando.recipe.yml")).exists(),
          // A failed hint lookup must not replace the original native error.
          catch: () => original,
        })));
    if (!legacy) return yield* Effect.fail(original);
    if (canonical)
      return yield* Effect.fail(
        new Lando3LandofileDetected({
          appRoot: source.appRoot,
          sourceFile: source.sourceFile,
          message: `Canonical Landofile ${source.sourceFile} contains Lando 3 configuration; native loading accepts only v4.`,
          remediation: "Run `lando4 app:config:translate --from lando3 --write`.",
        }),
      );
    if (source.validCanonicalFile !== undefined)
      return yield* Effect.fail(
        new LandofileDialectMixError({
          appRoot: source.appRoot,
          canonicalFile: source.validCanonicalFile,
          conflictingLayer: source.sourceFile,
          message: `Lando 3 layer ${relative(source.appRoot, source.sourceFile)} conflicts with v4 canonical Landofile ${source.validCanonicalFile}.`,
          remediation: `Run \`lando4 app:config:translate --from lando3 --file ${relative(source.appRoot, source.sourceFile)} --write\`.`,
        }),
      );
    return yield* Effect.fail(original);
  });
