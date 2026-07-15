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

import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_TOP_LEVEL_ACCEPTED_DISPLAY,
  COMPOSE_TOP_LEVEL_KEYS,
  type ConfigLintResult,
  type ConfigLintViolation,
  LandofileShape,
} from "@lando/sdk/schema";

import { LANDOFILE_NAME, LANDOFILE_TS_NAME, findLandofilePath } from "./discovery.ts";
import { presentLandofileLayers } from "./layers.ts";
import { mergeValues } from "./merge.ts";
import { parseLandofile } from "./parser.ts";
import { renderLandofileTemplate } from "./template-render.ts";
import { loadLandofileTs } from "./ts-loader.ts";

export interface LintLandofileOptions {
  /** Directory to search upward from for a Landofile. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape);

const lastKey = (path: ReadonlyArray<PropertyKey>): string | undefined =>
  path.length === 0 ? undefined : String(path[path.length - 1]);

const REJECTED_COMPOSE_TOP_LEVEL_REMEDIATION: Readonly<Record<string, string>> = {
  profiles:
    "Profiles are not part of Lando's portable Compose subset. Split profile-specific config into separate Landofile fragments and select them with includes: instead.",
  extensions:
    "Compose extensions are accepted only as x-* top-level keys. Rename this key to an x-* extension or move provider-specific data under providers.<provider-id>.",
};

const isAcceptedComposeTopLevelKey = (key: string): boolean =>
  (COMPOSE_TOP_LEVEL_KEYS as ReadonlyArray<string>).includes(key) || key.startsWith("x-");

const isDeprecatedComposeTopLevelKey = (key: string): boolean =>
  (COMPOSE_DEPRECATED_TOP_LEVEL_KEYS as ReadonlyArray<string>).includes(key);

const isRejectedComposeTopLevelKey = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(REJECTED_COMPOSE_TOP_LEVEL_REMEDIATION, key);

const composeSuggestedFix = (issue: {
  readonly _tag: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}): string | undefined => {
  // Compose matrix governs top-level keys only; nested issues keep their precise remediation.
  if (issue.path.length !== 1) return undefined;
  const key = String(issue.path[0]);
  if (issue._tag === "Unexpected" && isRejectedComposeTopLevelKey(key)) {
    return `Unsupported Compose top-level key "${key}". Supported top-level Compose keys are ${COMPOSE_TOP_LEVEL_ACCEPTED_DISPLAY}; version is deprecated. ${REJECTED_COMPOSE_TOP_LEVEL_REMEDIATION[key]}`;
  }
  if (issue._tag !== "Type" || issue.message.startsWith("Expected undefined")) return undefined;
  if (isAcceptedComposeTopLevelKey(key)) {
    return `The top-level Compose key "${key}" is accepted, but this value does not match Lando's supported schema-backed subset. Use only the supported shape for ${key}.`;
  }
  if (isDeprecatedComposeTopLevelKey(key)) {
    return `The top-level Compose key "${key}" is accepted only for compatibility and is ignored by Lando. Remove it from new Landofiles.`;
  }
  return undefined;
};

const sshAgentSuggestedFix = (issue: {
  readonly _tag: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}): string | undefined => {
  if (issue._tag !== "Type" || issue.path.map(String).join(".") !== "sshAgent.sidecar") return undefined;
  if (issue.message !== "Expected true, actual false") return undefined;
  return "The `sshAgent.sidecar: false` direct host SSH-agent socket mount is reserved and rejected. Use the supported sidecar path (`sshAgent.sidecar: true`, the default) instead.";
};

const violationFromIssue = (issue: {
  readonly _tag: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}): ConfigLintViolation => {
  const path = issue.path.map(String).join(".");
  const key = lastKey(issue.path);
  const suggestedFix =
    sshAgentSuggestedFix(issue) ??
    composeSuggestedFix(issue) ??
    (issue._tag === "Unexpected"
      ? `Remove the unknown key${key === undefined ? "" : ` "${key}"`}; it is not part of the canonical Landofile schema.`
      : issue._tag === "Missing"
        ? `Add the required "${key ?? path}" field.`
        : undefined);
  return suggestedFix === undefined
    ? { path, message: issue.message }
    : { path, message: issue.message, suggestedFix };
};

const appNameOf = (parsed: unknown): string => {
  if (parsed === null || typeof parsed !== "object") return "";
  const name = (parsed as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "";
};

const singleViolationResult = (
  file: string,
  message: string,
  location: { readonly line: number | undefined; readonly column: number | undefined } = {
    line: undefined,
    column: undefined,
  },
): ConfigLintResult => ({
  app: "",
  file,
  valid: false,
  violations: [
    {
      path: "",
      message,
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.column === undefined ? {} : { column: location.column }),
    },
  ],
});

/**
 * Lint the Landofile discovered upward from `cwd` against the canonical
 * schema. Resolves with a structured `ConfigLintResult` for any reachable,
 * parseable-or-not file. Fails only when no Landofile exists at all.
 */
export const lintLandofile = (
  options: LintLandofileOptions = {},
): Effect.Effect<ConfigLintResult, LandofileNotFoundError | LandofileFormConflictError, never> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const discovery = yield* Effect.tryPromise({
      try: () => findLandofilePath(cwd),
      catch: (cause) => cause,
    }).pipe(Effect.either);
    if (Either.isLeft(discovery)) {
      if (discovery.left instanceof LandofileFormConflictError) return yield* Effect.fail(discovery.left);
      const message =
        discovery.left instanceof Error ? discovery.left.message : "Failed to discover Landofile.";
      return singleViolationResult(cwd, message);
    }
    const filePath = discovery.right;
    if (filePath === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: `No ${LANDOFILE_NAME} or ${LANDOFILE_TS_NAME} found. Searched from ${cwd} upward.`,
          cwd,
        }),
      );
    }

    const layersDiscovery = yield* Effect.tryPromise({
      try: () => presentLandofileLayers(dirname(filePath)),
      catch: (cause) => cause,
    }).pipe(Effect.either);
    if (Either.isLeft(layersDiscovery)) {
      if (layersDiscovery.left instanceof LandofileFormConflictError) {
        return yield* Effect.fail(layersDiscovery.left);
      }
      const message =
        layersDiscovery.left instanceof Error
          ? layersDiscovery.left.message
          : "Failed to discover Landofile layers.";
      return singleViolationResult(filePath, message);
    }

    const parsedLayers: unknown[] = [];
    for (const layer of layersDiscovery.right) {
      const contentEither = yield* Effect.tryPromise(() => Bun.file(layer.filePath).text()).pipe(
        Effect.either,
      );
      if (Either.isLeft(contentEither)) {
        const cause = contentEither.left;
        const message = cause instanceof Error ? cause.message : `Failed to read ${layer.filePath}.`;
        return singleViolationResult(layer.filePath, message);
      }

      if (layer.filePath.endsWith(".ts")) {
        const loadedEither = yield* loadLandofileTs({
          filePath: layer.filePath,
          appRoot: dirname(filePath),
          content: contentEither.right,
        }).pipe(Effect.either);
        if (Either.isLeft(loadedEither)) {
          return singleViolationResult(layer.filePath, loadedEither.left.message);
        }
        parsedLayers.push(loadedEither.right);
        continue;
      }

      const renderedEither = yield* renderLandofileTemplate({
        filePath: layer.filePath,
        content: contentEither.right,
      }).pipe(Effect.either);
      if (Either.isLeft(renderedEither)) {
        const error = renderedEither.left;
        return singleViolationResult(layer.filePath, error.message, {
          line: error.line,
          column: error.column,
        });
      }

      const parsedEither = yield* parseLandofile({
        file: layer.filePath,
        content: renderedEither.right,
        cwd: dirname(filePath),
      }).pipe(Effect.either);
      if (Either.isLeft(parsedEither)) {
        const error = parsedEither.left;
        return singleViolationResult(layer.filePath, error.message, {
          line: error.line,
          column: error.column,
        });
      }
      parsedLayers.push(parsedEither.right);
    }

    const parsed = parsedLayers.reduce<unknown>((merged, layer) => mergeValues(merged, layer), {});
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
