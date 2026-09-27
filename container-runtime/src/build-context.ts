import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { TAR_BLOCK_SIZE, type UstarHeaderInput, encodeUstarHeader, endOfArchive, padToBlock } from "./tar.ts";

const textEncoder = new TextEncoder();

export type BuildContextEntry =
  | {
      readonly kind: "directory";
      readonly name: string;
      readonly mode: number;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly mode: number;
      readonly content: Uint8Array;
    }
  | {
      readonly kind: "symlink";
      readonly name: string;
      readonly mode: number;
      readonly linkName: string;
    };

type DockerignorePattern = {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
};

export interface PackedBuildContext {
  readonly entries: ReadonlyArray<BuildContextEntry>;
  readonly tar: AsyncIterable<Uint8Array>;
  readonly digest: string;
}

const normalizePath = (path: string): string => path.split(sep).join("/");
const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");

const segmentPattern = (segment: string): string => {
  let pattern = "";
  for (const char of segment) {
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += escapeRegex(char);
  }
  return pattern;
};

const pathPattern = (pattern: string): string =>
  pattern
    .split("/")
    .map((segment) => (segment === "**" ? ".*" : segmentPattern(segment)))
    .join("/");

const compileDockerignorePattern = (line: string): DockerignorePattern | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  const negated = trimmed.startsWith("!");
  const withoutNegation = negated ? trimmed.slice(1).trim() : trimmed;
  if (withoutNegation.length === 0) return undefined;
  const dirOnly = withoutNegation.endsWith("/");
  const rawPattern = withoutNegation.replace(/^\/+|\/+$/gu, "");
  if (rawPattern.length === 0) return undefined;
  const body = pathPattern(rawPattern);
  const source = rawPattern.includes("/") ? `^${body}(?:/.*)?$` : `^(?:.*/)?${body}(?:/.*)?$`;
  return { negated, dirOnly, regex: new RegExp(source, "u") };
};

const readDockerignore = async (root: string): Promise<ReadonlyArray<DockerignorePattern>> => {
  try {
    const content = await readFile(join(root, ".dockerignore"), "utf8");
    return content
      .split(/\r?\n/u)
      .map(compileDockerignorePattern)
      .filter((pattern) => pattern !== undefined);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
};

const ignoredBy = (
  patterns: ReadonlyArray<DockerignorePattern>,
  path: string,
  kind: "file" | "directory" | "symlink",
): boolean => {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.dirOnly && kind !== "directory" && !pattern.regex.test(path)) continue;
    if (pattern.regex.test(path)) ignored = !pattern.negated;
  }
  return ignored;
};

const walkContext = async (
  root: string,
  dir: string,
  patterns: ReadonlyArray<DockerignorePattern>,
): Promise<ReadonlyArray<BuildContextEntry>> => {
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const path = join(dir, dirent.name);
      const name = normalizePath(relative(root, path));
      if (dirent.isDirectory()) return walkContext(root, path, patterns);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        if (ignoredBy(patterns, name, "symlink")) return [];
        const entry: BuildContextEntry = {
          kind: "symlink",
          name,
          mode: stats.mode & 0o777,
          linkName: await readlink(path),
        };
        return [entry];
      }
      if (!stats.isFile() || ignoredBy(patterns, name, "file")) return [];
      const entry: BuildContextEntry = {
        kind: "file",
        name,
        mode: stats.mode & 0o777,
        content: await readFile(path),
      };
      return [entry];
    }),
  );
  return entries.flat().sort((left, right) => left.name.localeCompare(right.name));
};

const tarEntry = (entry: BuildContextEntry): Uint8Array => {
  let content: Uint8Array = new Uint8Array();
  let input: UstarHeaderInput;
  switch (entry.kind) {
    case "file":
      content = entry.content;
      input = { name: entry.name, mode: entry.mode, size: content.byteLength, typeflag: "0" };
      break;
    case "symlink":
      input = { name: entry.name, mode: entry.mode, size: 0, typeflag: "2", linkName: entry.linkName };
      break;
    case "directory":
      input = { name: entry.name, mode: entry.mode, size: 0, typeflag: "5" };
      break;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
  const header = encodeUstarHeader(input);
  const output = new Uint8Array(TAR_BLOCK_SIZE + content.byteLength + padToBlock(content.byteLength));
  output.set(header, 0);
  output.set(content, TAR_BLOCK_SIZE);
  return output;
};

export async function* tarStream(entries: ReadonlyArray<BuildContextEntry>): AsyncGenerator<Uint8Array> {
  for (const entry of entries) yield tarEntry(entry);
  yield endOfArchive();
}

export const contextContentDigest = async (entries: ReadonlyArray<BuildContextEntry>): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of tarStream(entries)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
};

export const packBuildContext = async (root: string): Promise<PackedBuildContext> => {
  await lstat(root);
  const patterns = await readDockerignore(root);
  const entries = await walkContext(root, root, patterns);
  return { entries, tar: tarStream(entries), digest: await contextContentDigest(entries) };
};

export const buildContextContentDigest = async (root: string): Promise<string> =>
  (await packBuildContext(root)).digest;

export const tarText = (value: string): Uint8Array => textEncoder.encode(value);
