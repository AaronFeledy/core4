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

import { LandofileNotFoundError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { parseLandofile } from "./parser.ts";

export { LandofileService } from "@lando/sdk/services";

const LANDOFILE_NAME = ".lando.yml";
const REMEDIATION =
  "Remove unsupported keys or update the MVP Landofile subset in spec/07-landofile-and-config.md.";

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
      Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
      Effect.flatMap((parsed) => validateLandofile(filePath, parsed)),
    ),
  ),
  Effect.mapError((error) => {
    if (
      error instanceof LandofileNotFoundError ||
      error instanceof LandofileParseError ||
      error instanceof LandofileValidationError
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
