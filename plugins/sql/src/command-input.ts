import { isAbsolute, join, relative, resolve } from "node:path";

import type { ExecutableCommandInput } from "@lando/sdk/plugins";

import type { DbAction, DbCommandInput } from "./command-types.ts";
import type { SqlPlan } from "./views.ts";

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

export const secretTokens = (creds: {
  readonly password?: string;
  readonly rootPassword?: string;
}): string[] =>
  [creds.password, creds.rootPassword].flatMap((token) =>
    token === undefined || token.length === 0 ? [] : [token],
  );

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
  ...(typeof input.flags["keep-latest"] === "number" ? { keepLatest: input.flags["keep-latest"] } : {}),
  ...(input.flags.preview === true ? { preview: true } : {}),
  ...(input.flags.compression === "gzip" ||
  input.flags.compression === "zstd" ||
  input.flags.compression === "none"
    ? { compression: input.flags.compression }
    : {}),
});
