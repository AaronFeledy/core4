/**
 * `LandofileService` Live Layer.
 *
 * Discovery (MVP scope per PRD-03 US-005):
 * - Walks upward from `process.cwd()`; first directory containing `.lando.yml`
 *   becomes the *app root*.
 * - Bounded by filesystem root (`dirname(current) === current`).
 * - Uses `Bun.file(...).exists()` directly; no caching at MVP.
 *
 * Deferred for later passes (NOT implemented here):
 * - `.lando.stop` sentinel
 * - configurable `discovery.maxDepth`
 * - `FileSystem.readdir` integration and per-CWD caching
 */
import { dirname, join } from "node:path";

import { Cause, type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import {
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { parseLandofile } from "./parser.ts";

export { LandofileService } from "@lando/sdk/services";

const LANDOFILE_NAME = ".lando.yml";
const REMEDIATION =
  "Remove unsupported keys or update the MVP Landofile subset in spec/07-landofile-and-config.md.";

const BETA_REMEDIATION = "Remove the section; this surface is deferred to the Beta release.";

const BETA_TOP_LEVEL_KEYS: ReadonlyArray<{
  key: string;
  specSection: string;
  description: string;
}> = [
  { key: "includes", specSection: "§7.7", description: "Landofile includes/fragments" },
  { key: "secrets", specSection: "§4.2/§7.4", description: "Landofile secrets" },
  { key: "env_file", specSection: "§7.6", description: "Landofile env file overrides" },
];

const scanForBetaTopLevelKey = (parsed: unknown): { key: string; specSection: string } | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const entry of BETA_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(obj, entry.key)) return entry;
  }
  return undefined;
};

const CONFIG_EXPRESSION_PATTERN = /\$\{[A-Za-z_]/;
const TEMPLATE_EXPRESSION_PATTERN = /\{\{/;

const scanForConfigExpression = (
  content: string,
): { specSection: string; description: string } | undefined => {
  const withoutComments = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
  if (CONFIG_EXPRESSION_PATTERN.test(withoutComments)) {
    return { specSection: "§7.3.1", description: "Configuration expressions (${...})" };
  }
  if (TEMPLATE_EXPRESSION_PATTERN.test(withoutComments)) {
    return { specSection: "§7.3.1", description: "Template expressions ({{ ... }})" };
  }
  return undefined;
};

const findLandofile = async (
  cwd: string,
): Promise<{ readonly filePath: string; readonly searched: ReadonlyArray<string> }> => {
  const searched: string[] = [];
  let current = cwd;

  for (;;) {
    const candidate = join(current, LANDOFILE_NAME);
    searched.push(candidate);
    if (await Bun.file(candidate).exists()) return { filePath: candidate, searched };

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new LandofileNotFoundError({
    message: `No ${LANDOFILE_NAME} found. Searched: ${searched.join(", ")}`,
    cwd,
  });
};

const extractFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const failure = Cause.failureOption(cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const validateLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<typeof LandofileShape.Type, LandofileValidationError> => {
  const result = Schema.decodeUnknownEither(LandofileShape)(parsed, { onExcessProperty: "error" });
  if (Either.isRight(result)) return Effect.succeed(result.right);

  const issues = validationIssues(result.left);
  return Effect.fail(
    new LandofileValidationError({
      message: `Landofile contains unsupported MVP keys: ${issues.join(", ")}. ${REMEDIATION}`,
      file: filePath,
      issues,
    }),
  );
};

const scanContentForBetaExpressions = (
  filePath: string,
  content: string,
): Effect.Effect<string, NotImplementedError> => {
  const match = scanForConfigExpression(content);
  if (match === undefined) return Effect.succeed(content);
  return Effect.fail(
    new NotImplementedError({
      message: `${match.description} are not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      specSection: match.specSection,
      remediation: BETA_REMEDIATION,
    }),
  );
};

const rejectBetaTopLevelKeys = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const beta = scanForBetaTopLevelKey(parsed);
  if (beta === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: `Top-level "${beta.key}:" is not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      specSection: beta.specSection,
      remediation: BETA_REMEDIATION,
    }),
  );
};

const discoverLandofile = Effect.tryPromise({
  try: async () => await findLandofile(process.cwd()),
  catch: (cause) =>
    cause instanceof LandofileNotFoundError
      ? cause
      : new LandofileParseError({
          message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
          filePath: join(process.cwd(), LANDOFILE_NAME),
          line: undefined,
          column: undefined,
          cause,
        }),
}).pipe(
  Effect.flatMap(({ filePath }) =>
    Effect.tryPromise({
      try: async () => await Bun.file(filePath).text(),
      catch: (cause) =>
        new LandofileParseError({
          message: cause instanceof Error ? cause.message : `Failed to read ${filePath}`,
          filePath,
          line: undefined,
          column: undefined,
          cause,
        }),
    }).pipe(
      Effect.flatMap((content) => scanContentForBetaExpressions(filePath, content)),
      Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
      Effect.flatMap((parsed) => rejectBetaTopLevelKeys(filePath, parsed)),
      Effect.flatMap((parsed) => validateLandofile(filePath, parsed)),
    ),
  ),
  Effect.mapError((error) => {
    if (
      error instanceof LandofileNotFoundError ||
      error instanceof LandofileParseError ||
      error instanceof LandofileValidationError ||
      error instanceof NotImplementedError
    ) {
      return error;
    }
    return new LandofileParseError({
      message: "Failed to load Landofile.",
      filePath: join(process.cwd(), LANDOFILE_NAME),
      line: undefined,
      column: undefined,
      cause: error,
    });
  }),
  Effect.catchAllCause((cause) => {
    const failure = extractFailure(cause);
    if (failure !== undefined) return Effect.fail(failure);
    return Effect.fail(
      new LandofileParseError({
        message: "Failed to load Landofile.",
        filePath: join(process.cwd(), LANDOFILE_NAME),
        line: undefined,
        column: undefined,
        cause,
      }),
    );
  }),
);

const landofileService: Context.Tag.Service<typeof LandofileService> = {
  discover: discoverLandofile,
};

export const LandofileServiceLive = Layer.succeed(LandofileService, landofileService);
