import { isAbsolute, join, relative, resolve } from "node:path";

import { Effect, Match } from "effect";

import { CommandInputValidationError } from "@lando/sdk/errors";
import type { ExecutableCommandInput } from "@lando/sdk/plugins";

import type { DbAction, DbCommandInput } from "./command-types.ts";
import { compressionFromExportPath } from "./compression.ts";
import { DEFAULT_SQL_PASSWORD } from "./creds.ts";
import type { SqlLandofileService, SqlPlan } from "./views.ts";

export const hostFile = (
  plan: SqlPlan,
  input: { readonly service: string; readonly file?: string; readonly hostCwd?: string },
): string => {
  const file = input.file ?? `${input.service}.sql.gz`;
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

export const validateExportCompressionLevel = (
  input: DbCommandInput,
): Effect.Effect<void, CommandInputValidationError> => {
  if (input.action !== "export" || input.compressionLevel === undefined) return Effect.void;
  const compression = compressionFromExportPath(input.file ?? "dump.sql.gz");
  const level = input.compressionLevel;
  const message = !Number.isSafeInteger(level)
    ? "--compression-level must be an integer."
    : Match.value(compression).pipe(
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
        new CommandInputValidationError({
          message,
          target: "db:export",
          field: "compression-level",
          kind: "flag",
          reason: "constraint",
          remediation:
            "Use an integer from 0-9 with a .gz destination or 1-22 with a .zst destination, or omit --compression-level.",
        }),
      );
};

export const secretTokens = (
  creds: { readonly password?: string; readonly rootPassword?: string },
  authored?: SqlLandofileService,
): string[] => {
  const authoredPasswords = [
    authored?.creds?.password,
    authored?.creds?.rootPassword,
    ...Object.entries(authored?.environment ?? {})
      .filter(([key]) => /PASSWORD$/u.test(key))
      .map(([, value]) => value),
  ];
  const password =
    creds.password === undefined ||
    creds.password.length === 0 ||
    (creds.password === DEFAULT_SQL_PASSWORD && !authoredPasswords.includes(creds.password))
      ? []
      : [creds.password];
  const rootPassword =
    creds.rootPassword === undefined || creds.rootPassword.length === 0 ? [] : [creds.rootPassword];
  return [...password, ...rootPassword];
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
