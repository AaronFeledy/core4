/**
 * Schema-only Landofile linting.
 *
 * `lintLandofile` validates the current app directory's Landofile against the
 * canonical `LandofileShape` JSON Schema and ONLY that — no translators, no
 * doctor checks, no provider probes, and (deliberately) none of the
 * gated-key/expression scanners that `LandofileService.discover` layers on top
 * of the decode. Unknown keys surface as excess-property violations rather
 * than `NotImplementedError`, which is exactly what an editor wants.
 *
 * It is the single source of truth shared by `lando app:config:lint` and
 * `lando doctor --app`.
 */
import { dirname } from "node:path";

import { Effect, Either, ParseResult, Schema } from "effect";

import { LandofileNotFoundError } from "@lando/sdk/errors";
import { type ConfigLintResult, type ConfigLintViolation, LandofileShape } from "@lando/sdk/schema";

import { LANDOFILE_NAME, findLandofilePath } from "./discovery.ts";
import { parseLandofile } from "./parser.ts";
import { renderLandofileTemplate } from "./template-render.ts";

export interface LintLandofileOptions {
  /** Directory to search upward from for a Landofile. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape);

const lastKey = (path: ReadonlyArray<PropertyKey>): string | undefined =>
  path.length === 0 ? undefined : String(path[path.length - 1]);

const violationFromIssue = (issue: {
  readonly _tag: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}): ConfigLintViolation => {
  const path = issue.path.map(String).join(".");
  const key = lastKey(issue.path);
  const suggestedFix =
    issue._tag === "Unexpected"
      ? `Remove the unknown key${key === undefined ? "" : ` "${key}"`}; it is not part of the canonical Landofile schema.`
      : issue._tag === "Missing"
        ? `Add the required "${key ?? path}" field.`
        : undefined;
  return suggestedFix === undefined
    ? { path, message: issue.message }
    : { path, message: issue.message, suggestedFix };
};

const appNameOf = (parsed: unknown): string => {
  if (parsed === null || typeof parsed !== "object") return "";
  const name = (parsed as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "";
};

const singleViolationResult = (file: string, message: string): ConfigLintResult => ({
  app: "",
  file,
  valid: false,
  violations: [{ path: "", message }],
});

/**
 * Lint the Landofile discovered upward from `cwd` against the canonical
 * schema. Resolves with a structured `ConfigLintResult` for any reachable,
 * parseable-or-not file. Fails only when no Landofile exists at all.
 */
export const lintLandofile = (
  options: LintLandofileOptions = {},
): Effect.Effect<ConfigLintResult, LandofileNotFoundError, never> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const filePath = yield* Effect.promise(() => findLandofilePath(cwd));
    if (filePath === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: `No ${LANDOFILE_NAME} found. Searched from ${cwd} upward.`,
          cwd,
        }),
      );
    }

    const contentEither = yield* Effect.tryPromise(() => Bun.file(filePath).text()).pipe(Effect.either);
    if (Either.isLeft(contentEither)) {
      const cause = contentEither.left;
      const message = cause instanceof Error ? cause.message : `Failed to read ${filePath}.`;
      return singleViolationResult(filePath, message);
    }

    const renderedEither = yield* renderLandofileTemplate({
      filePath,
      content: contentEither.right,
    }).pipe(Effect.either);
    if (Either.isLeft(renderedEither)) {
      return singleViolationResult(filePath, renderedEither.left.message);
    }

    const parsedEither = yield* parseLandofile({
      file: filePath,
      content: renderedEither.right,
      cwd: dirname(filePath),
    }).pipe(Effect.either);
    if (Either.isLeft(parsedEither)) {
      return singleViolationResult(filePath, parsedEither.left.message);
    }

    const parsed = parsedEither.right;
    const decoded = decodeLandofile(parsed, { onExcessProperty: "error", errors: "all" });
    const violations = Either.isRight(decoded)
      ? []
      : ParseResult.ArrayFormatter.formatErrorSync(decoded.left).map(violationFromIssue);

    return {
      app: appNameOf(parsed),
      file: filePath,
      valid: violations.length === 0,
      violations,
    };
  });
