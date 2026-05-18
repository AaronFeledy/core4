import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Effect, Either, ParseResult, Schema } from "effect";

import {
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { BunShellScriptFrontMatter } from "@lando/sdk/schema";

export const BUN_SHELL_SCRIPT_EXTENSION = ".bun.sh";
export const SCRIPTS_DIRNAME = join(".lando", "scripts");

export interface DiscoveredBunShellScript {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly service: string;
  readonly summary: string;
  readonly frontMatter: BunShellScriptFrontMatter;
}

export type BunShellScriptDiscoveryError =
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | NotImplementedError;

const HOST_SERVICE = ":host";

const BETA_FRONT_MATTER_KEYS: ReadonlyArray<{ key: string; specSection: string }> = [
  { key: "aliases", specSection: "§8.5.1" },
  { key: "topLevelAlias", specSection: "§8.5.1" },
  { key: "bootstrap", specSection: "§8.5.1" },
  { key: "flags", specSection: "§8.5.1" },
  { key: "args", specSection: "§8.5.1" },
  { key: "passThrough", specSection: "§8.5.1" },
  { key: "sources", specSection: "§8.5.6" },
  { key: "generates", specSection: "§8.5.6" },
  { key: "status", specSection: "§8.5.6" },
  { key: "preconditions", specSection: "§8.5.6" },
  { key: "run", specSection: "§8.5.6" },
  { key: "platforms", specSection: "§8.5.1" },
  { key: "internal", specSection: "§8.5.1" },
  { key: "disabled", specSection: "§8.5.1" },
  { key: "engine", specSection: "§8.5.1" },
];

const BETA_REMEDIATION =
  "Remove the field from the .bun.sh front-matter; this surface is deferred to the Beta release.";

const FRONT_MATTER_REMEDIATION =
  "Wrap the front-matter in `# ---` markers, prefix every line with `# `, and use only the Alpha keys: service, desc, description, summary.";

const isFrontMatterFenceLine = (line: string): boolean => line.replace(/\s+$/, "") === "# ---";

const isFrontMatterBodyLine = (line: string): boolean =>
  line === "#" || line === "#\r" || line.startsWith("# ") || line.startsWith("#\t");

const stripFrontMatterPrefix = (line: string): string => {
  if (line.startsWith("# ")) return line.slice(2);
  if (line.startsWith("#\t")) return line.slice(2);
  if (line === "#" || line === "#\r") return "";
  return line;
};

interface FrontMatterRegion {
  readonly start: number;
  readonly end: number;
  readonly body: ReadonlyArray<string>;
}

const findFrontMatterRegion = (
  lines: ReadonlyArray<string>,
): { region: FrontMatterRegion | undefined; reason: "missing" | "malformed" | "ok" } => {
  let index = 0;
  if (lines[index]?.startsWith("#!")) index += 1;
  while (index < lines.length && lines[index]?.trim() === "") index += 1;

  const startLine = lines[index];
  if (startLine === undefined) return { region: undefined, reason: "missing" };
  if (!isFrontMatterFenceLine(startLine)) return { region: undefined, reason: "missing" };

  const start = index;
  const bodyStart = index + 1;
  let cursor = bodyStart;
  while (cursor < lines.length) {
    const current = lines[cursor] ?? "";
    if (isFrontMatterFenceLine(current)) {
      const body = lines.slice(bodyStart, cursor).map(stripFrontMatterPrefix);
      return { region: { start, end: cursor, body }, reason: "ok" };
    }
    if (!isFrontMatterBodyLine(current)) {
      return { region: undefined, reason: "malformed" };
    }
    cursor += 1;
  }
  return { region: undefined, reason: "malformed" };
};

const parseFrontMatterScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontMatterBody = (
  body: ReadonlyArray<string>,
): { parsed: Record<string, unknown>; malformedLine?: number } => {
  const result: Record<string, unknown> = {};
  for (const [index, raw] of body.entries()) {
    const trimmed = raw.replace(/\s+$/, "");
    if (trimmed === "") continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (match === null) return { parsed: result, malformedLine: index };
    const [, key, rawValue] = match as [string, string, string];
    result[key] = parseFrontMatterScalar(rawValue);
  }
  return { parsed: result };
};

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid .bun.sh front-matter."];
};

const decodeFrontMatter = (
  scriptPath: string,
  parsed: Record<string, unknown>,
): Effect.Effect<BunShellScriptFrontMatter, BunShellScriptFrontMatterError> => {
  const result = Schema.decodeUnknownEither(BunShellScriptFrontMatter)(parsed, {
    onExcessProperty: "error",
  });
  if (Either.isRight(result)) return Effect.succeed(result.right);
  return Effect.fail(
    new BunShellScriptFrontMatterError({
      message: `.bun.sh front-matter at ${scriptPath} is malformed.`,
      path: scriptPath,
      issues: validationIssues(result.left),
      remediation: FRONT_MATTER_REMEDIATION,
    }),
  );
};

const detectBetaKey = (parsed: Record<string, unknown>): { key: string; specSection: string } | undefined => {
  for (const entry of BETA_FRONT_MATTER_KEYS) {
    if (Object.hasOwn(parsed, entry.key)) return entry;
  }
  return undefined;
};

const sanitizeSegment = (segment: string): string => {
  const lowered = segment.toLowerCase();
  return lowered
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const canonicalIdFromRelativePath = (relativePath: string): { name: string; id: string } | null => {
  if (!relativePath.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) return null;
  const withoutExt = relativePath.slice(0, -BUN_SHELL_SCRIPT_EXTENSION.length);
  const segments = withoutExt
    .split(/[\\/]/)
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const name = segments.join(":");
  return { name, id: `app:${name}` };
};

const parseScriptFile = (
  scriptPath: string,
  relativePath: string,
): Effect.Effect<DiscoveredBunShellScript, BunShellScriptDiscoveryError> =>
  Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(scriptPath, "utf-8"),
      catch: (cause) =>
        new BunShellScriptFrontMatterError({
          message: `Failed to read .bun.sh script at ${scriptPath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          path: scriptPath,
          remediation: FRONT_MATTER_REMEDIATION,
          cause,
        }),
    });

    if (content.trim() === "") {
      return yield* Effect.fail(
        new BunShellScriptEmptyError({
          message: `.bun.sh script at ${scriptPath} is empty.`,
          path: scriptPath,
          remediation: "Add a `# ---` front-matter block and a script body, or delete the file.",
        }),
      );
    }

    const lines = content.split(/\r?\n/);
    const { region, reason } = findFrontMatterRegion(lines);
    if (region === undefined) {
      return yield* Effect.fail(
        new BunShellScriptFrontMatterError({
          message:
            reason === "missing"
              ? `.bun.sh script at ${scriptPath} is missing the front-matter block.`
              : `.bun.sh script at ${scriptPath} has a malformed front-matter block.`,
          path: scriptPath,
          remediation: FRONT_MATTER_REMEDIATION,
        }),
      );
    }

    const { parsed, malformedLine } = parseFrontMatterBody(region.body);
    if (malformedLine !== undefined) {
      return yield* Effect.fail(
        new BunShellScriptFrontMatterError({
          message: `.bun.sh front-matter at ${scriptPath} has a malformed YAML line.`,
          path: scriptPath,
          issues: [`line ${malformedLine + 1}: expected "key: value"`],
          remediation: FRONT_MATTER_REMEDIATION,
        }),
      );
    }

    const beta = detectBetaKey(parsed);
    if (beta !== undefined) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `.bun.sh front-matter field "${beta.key}:" at ${scriptPath} is not supported in Alpha (${beta.specSection}).`,
          commandId: "landofile.parse",
          specSection: beta.specSection,
          remediation: BETA_REMEDIATION,
        }),
      );
    }

    const frontMatter = yield* decodeFrontMatter(scriptPath, parsed);

    const canonical = canonicalIdFromRelativePath(relativePath);
    if (canonical === null) {
      return yield* Effect.fail(
        new BunShellScriptFrontMatterError({
          message: `.bun.sh script at ${scriptPath} has no usable canonical name (relative path "${relativePath}").`,
          path: scriptPath,
          remediation:
            "Rename the file or directory so each path segment matches [a-z0-9_-]+ after lower-casing.",
        }),
      );
    }

    const service = frontMatter.service ?? HOST_SERVICE;
    const summary = frontMatter.description ?? frontMatter.summary ?? frontMatter.desc ?? "";

    return {
      id: canonical.id,
      name: canonical.name,
      path: scriptPath,
      relativePath,
      service,
      summary,
      frontMatter,
    } satisfies DiscoveredBunShellScript;
  });

interface WalkEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
}

const walkScriptsDir = async (root: string): Promise<ReadonlyArray<WalkEntry>> => {
  const found: WalkEntry[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) continue;
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      found.push({ absolutePath, relativePath });
    }
  };
  await visit(root);
  return found;
};

const scriptsDirExists = async (scriptsDir: string): Promise<boolean> => {
  const s = await stat(scriptsDir).catch(() => undefined);
  return s?.isDirectory() === true;
};

export interface DiscoverBunShellScriptsOptions {
  readonly appRoot: string;
}

export const discoverBunShellScripts = (
  options: DiscoverBunShellScriptsOptions,
): Effect.Effect<ReadonlyArray<DiscoveredBunShellScript>, BunShellScriptDiscoveryError> =>
  Effect.gen(function* () {
    const scriptsDir = join(options.appRoot, SCRIPTS_DIRNAME);
    const exists = yield* Effect.promise(() => scriptsDirExists(scriptsDir));
    if (!exists) return [] as ReadonlyArray<DiscoveredBunShellScript>;

    const entries = yield* Effect.tryPromise({
      try: () => walkScriptsDir(scriptsDir),
      catch: (cause) =>
        new BunShellScriptFrontMatterError({
          message: `Failed to read .lando/scripts directory at ${scriptsDir}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          path: scriptsDir,
          remediation: "Ensure the directory is readable by the current user.",
          cause,
        }),
    });

    const seen = new Map<string, string>();
    const out: DiscoveredBunShellScript[] = [];
    for (const entry of entries) {
      const script = yield* parseScriptFile(entry.absolutePath, entry.relativePath);
      const previous = seen.get(script.id);
      if (previous !== undefined) {
        return yield* Effect.fail(
          new BunShellScriptFrontMatterError({
            message: `.bun.sh scripts at ${previous} and ${entry.absolutePath} resolve to the same canonical id ${script.id}.`,
            path: entry.absolutePath,
            remediation:
              "Rename one of the conflicting scripts so each canonical id (app:<segments>) is unique.",
          }),
        );
      }
      seen.set(script.id, entry.absolutePath);
      out.push(script);
    }

    return out.sort((a, b) => a.id.localeCompare(b.id));
  });
