import { isAbsolute, join, relative, resolve } from "node:path";
import { CommandInputValidationError, CommandStdioError } from "@lando/sdk/errors";
import type { ExecutableCommandInput } from "@lando/sdk/plugins";
import type { EnvironmentValue } from "@lando/sdk/schema";
import { isUsableExactRedactionValue } from "@lando/sdk/secrets";
import { Effect, Match, type Stream } from "effect";
import type { DbAction, DbCommandInput } from "./command-types.ts";
import { type DumpCompression, compressionFromExportPath } from "./compression.ts";
import { classifySqlPlan } from "./environment.ts";

import type { SqlPlan } from "./views.ts";

export const hostFile = (
  plan: SqlPlan,
  input: { readonly service: string; readonly file?: string; readonly hostCwd?: string },
): string => {
  const file = input.file ?? `${input.service}.sql.gz`;
  // Keep dash as the stdio sentinel; never resolve it as a host path.
  if (file === "-") return "-";
  if (isAbsolute(file)) return file;
  const hostCwd = input.hostCwd ?? process.cwd();
  const rel = relative(resolve(plan.root), resolve(hostCwd));
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return join(inside ? hostCwd : plan.root, file);
};

export const parseCount = (stdout: string): number | undefined => {
  const match = stdout.trim().match(/\d+/u);
  if (match === null) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
};

/** `-` compresses only when asked with --compression; a file export follows its suffix. */
export const exportCompression = (input: DbCommandInput): DumpCompression =>
  input.file === "-" ? (input.compression ?? "none") : compressionFromExportPath(input.file ?? "dump.sql.gz");

const exportFlagError = (field: string, message: string, remediation: string) =>
  new CommandInputValidationError({
    message,
    target: "db:export",
    field,
    kind: "flag",
    reason: "constraint",
    remediation,
  });

export const validateExportCompression = (
  input: DbCommandInput,
): Effect.Effect<void, CommandInputValidationError> => {
  if (input.action !== "export") return Effect.void;
  if (input.compression !== undefined && input.file !== "-") {
    return Effect.fail(
      exportFlagError(
        "compression",
        "--compression applies only to a dump written to stdout (-).",
        "Name the file with a .gz or .zst suffix to compress it, or pass - to stream the dump to stdout.",
      ),
    );
  }
  if (input.compressionLevel === undefined) return Effect.void;
  const level = input.compressionLevel;
  const message = !Number.isSafeInteger(level)
    ? "--compression-level must be an integer."
    : Match.value(exportCompression(input)).pipe(
        Match.when("none", () => "--compression-level cannot be used with an uncompressed export."),
        Match.when("gzip", () =>
          level < 0 || level > 9 ? "gzip --compression-level must be between 0 and 9." : undefined,
        ),
        Match.when("zstd", () =>
          level < 1 || level > 22 ? "zstd --compression-level must be between 1 and 22." : undefined,
        ),
        Match.exhaustive,
      );
  return message === undefined
    ? Effect.void
    : Effect.fail(
        exportFlagError(
          "compression-level",
          message,
          "Use an integer from 0-9 for gzip or 1-22 for zstd, chosen by the .gz or .zst suffix or by --compression with -, or omit --compression-level.",
        ),
      );
};

export const secretTokens = (
  creds: {
    readonly user?: EnvironmentValue;
    readonly database?: EnvironmentValue;
    readonly password?: EnvironmentValue;
    readonly rootPassword?: EnvironmentValue;
  },
  plan: SqlPlan,
): string[] => {
  // Result tokens are substring-only; never promote whole-token or public values.
  const classified = classifySqlPlan(plan);
  const tokens: string[] = [];
  for (const value of [creds.password, creds.rootPassword]) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (!isUsableExactRedactionValue(value)) continue;
    if (classified.publicValues.has(value)) continue;
    if (value === creds.user || value === creds.database) continue;
    if (classified.wholeToken.has(value) && !classified.substring.has(value)) continue;
    tokens.push(value);
  }
  return tokens;
};

export type DumpStdio =
  | { readonly _tag: "stdout"; readonly write: (chunk: Uint8Array) => Effect.Effect<void> }
  | { readonly _tag: "stdin"; readonly stream: Stream.Stream<Uint8Array, CommandStdioError> };

const stdioUnavailable = (action: DbCommandInput["action"], stream: "stdin" | "stdout") =>
  new CommandStdioError({
    message: `db:${action} requested ${stream} for -, but no ${stream} stream was granted.`,
    command: `db:${action}`,
    stream,
    reason: "unavailable",
    remediation: "Run this command from the terminal CLI, or pass a file path instead of -.",
  });

/** The one place a `-` dump path is checked against the CLI's stdio grant. */
export const resolveDumpStdio = (
  input: DbCommandInput,
): Effect.Effect<DumpStdio | undefined, CommandStdioError> => {
  if (input.file !== "-") return Effect.succeed(undefined);
  if (input.action === "export") {
    const write = input.stdio?.stdout;
    return write === undefined
      ? Effect.fail(stdioUnavailable(input.action, "stdout"))
      : Effect.succeed({ _tag: "stdout", write });
  }
  if (input.action === "import" || input.action === "seed") {
    const stream = input.stdio?.stdin;
    return stream === undefined
      ? Effect.fail(stdioUnavailable(input.action, "stdin"))
      : Effect.succeed({ _tag: "stdin", stream });
  }
  return Effect.succeed(undefined);
};

export const dbCommandRedactionTokens = (result: unknown): ReadonlyArray<string> => {
  if (typeof result !== "object" || result === null || !("redactionTokens" in result)) return [];
  const tokens = result.redactionTokens;
  return Array.isArray(tokens) ? tokens.filter((token): token is string => typeof token === "string") : [];
};

export const dbInputFromCommand = (action: DbAction, input: ExecutableCommandInput): DbCommandInput => ({
  action,
  yes: input.flags.yes === true,
  hostCwd: process.cwd(),
  ...(typeof input.flags.service === "string" ? { service: input.flags.service } : {}),
  ...(typeof input.args.file === "string" ? { file: input.args.file } : {}),
  ...(input.stdio === undefined ? {} : { stdio: input.stdio }),
  ...(typeof input.args.snapshot === "string"
    ? { snapshotId: input.args.snapshot }
    : typeof input.flags.snapshot === "string"
      ? { snapshotId: input.flags.snapshot }
      : {}),
  ...(typeof input.flags.label === "string" ? { label: input.flags.label } : {}),
  ...(typeof input.flags["from-app"] === "string" ? { fromApp: input.flags["from-app"] } : {}),
  ...(typeof input.flags["from-path"] === "string" ? { fromPath: input.flags["from-path"] } : {}),
  ...(typeof input.flags["from-service"] === "string" ? { fromService: input.flags["from-service"] } : {}),
  ...(typeof input.flags["keep-latest"] === "number" ? { keepLatest: input.flags["keep-latest"] } : {}),
  ...(action === "export" && typeof input.flags["compression-level"] === "number"
    ? { compressionLevel: input.flags["compression-level"] }
    : {}),
  ...(input.flags.preview === true ? { preview: true } : {}),
  ...(input.flags.compression === "gzip" ||
  input.flags.compression === "zstd" ||
  input.flags.compression === "none"
    ? { compression: input.flags.compression }
    : {}),
});
