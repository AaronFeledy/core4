import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Effect, ParseResult, Schema } from "effect";

import { LandofileIncludeError, LandofileLockMismatchError, LandofileParseError } from "@lando/sdk/errors";
import { AbsolutePath, type IncludeEntry, LandofileShape } from "@lando/sdk/schema";
import type { StateBucket, StateRoot } from "@lando/sdk/services";

import { resolveUserCacheRoot } from "../cache/paths.ts";
import { type GitRecipeCloner, defaultGitRecipeCloner, publish } from "../recipes/git-source.ts";
import { type NpmPackument, type NpmRegistryClient, parseNpmPackageSpec } from "../recipes/npm-source.ts";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  defaultTarballRecipeExtractor,
  defaultTarballRecipeFetcher,
} from "../recipes/tarball-source.ts";
import { makeStateStore } from "../state/service.ts";
import { mergeLandofiles } from "./merge.ts";
import { parseLandofile } from "./parser.ts";

export type GitIncludeCloner = GitRecipeCloner;
export type NpmIncludeRegistryClient = NpmRegistryClient;
export type NpmIncludeFetcher = TarballRecipeFetcher;
export type NpmIncludeExtractor = TarballRecipeExtractor;

export interface LandofileIncludeDeps {
  readonly gitCloner?: GitIncludeCloner;
  readonly npmRegistryClient?: NpmIncludeRegistryClient;
  readonly npmFetcher?: NpmIncludeFetcher;
  readonly npmExtractor?: NpmIncludeExtractor;
}

export interface ResolveLandofileIncludesOptions {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly now?: () => number;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
}

interface NormalizedInclude {
  readonly source: string;
  readonly kind?: "landofile";
  readonly path?: string;
  readonly version?: string;
  readonly checksum?: string;
}

interface LockEntry {
  readonly source: string;
  readonly resolved: string;
  readonly checksum: string;
}

interface ResolveContext {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly lockfilePath: string;
  readonly deps: LandofileIncludeDeps;
  readonly maxDepth: number;
  readonly mode: "pin" | "refresh";
  readonly lockEntries: ReadonlyMap<string, LockEntry>;
  readonly stagedLocks: Map<string, LockEntry>;
}

interface FragmentResult {
  readonly sourceId: string;
  readonly resolved?: string;
  readonly content: string;
  readonly filePath: string;
  readonly root: string;
  readonly locked: boolean;
}

const LOCK_REMEDIATION =
  "Run lando app:includes:update to refresh .lando.lock.yml after reviewing the include change.";
const INCLUDE_REMEDIATION =
  "Check the includes: entry and retry after the referenced Landofile fragment is available.";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const includeError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: LandofileIncludeError["kind"];
  readonly remediation?: string;
}): LandofileIncludeError =>
  new LandofileIncludeError({
    message: input.message,
    source: input.source,
    kind: input.kind,
    remediation: input.remediation ?? INCLUDE_REMEDIATION,
  });

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const normalizeInclude = (entry: IncludeEntry): NormalizedInclude =>
  typeof entry === "string"
    ? { source: entry }
    : {
        source: entry.source,
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.path === undefined ? {} : { path: entry.path }),
        ...(entry.version === undefined ? {} : { version: entry.version }),
        ...(entry.checksum === undefined ? {} : { checksum: entry.checksum }),
      };

const safeRelativeSubpath = (subpath: string | undefined, source: string): string => {
  if (subpath === undefined || subpath.trim() === "") {
    throw includeError({
      message: `Remote include ${source} must specify a fragment path.`,
      source,
      kind: "subpath-invalid",
      remediation: "Set includes[].path to a relative YAML fragment path inside the remote source.",
    });
  }
  const slashPath = subpath.replace(/\\/gu, "/");
  if (isAbsolute(subpath) || slashPath.startsWith("/")) {
    throw includeError({
      message: `Include subpath must be relative: ${subpath}`,
      source,
      kind: "subpath-invalid",
    });
  }
  const normalized = relative(".", resolve(".", slashPath));
  if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw includeError({
      message: `Include subpath escapes the source root: ${subpath}`,
      source,
      kind: "subpath-invalid",
    });
  }
  return normalized;
};

const assertUnderRoot = async (
  root: string,
  path: string,
  source: string,
  rootLabel = "app root",
): Promise<string> => {
  const rootReal = await realpathOrSelf(root);
  const pathReal = await realpathOrSelf(path);
  const rel = relative(rootReal, pathReal);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw includeError({
      message: `Include ${source} resolves outside the ${rootLabel}.`,
      source,
      kind: "outside-root",
      remediation: `Use an include path that stays inside the ${rootLabel}.`,
    });
  }
  return pathReal;
};

const realpathOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

const readText = async (path: string, source: string): Promise<string> => {
  try {
    return await Bun.file(path).text();
  } catch (cause) {
    throw includeError({
      message: `Could not read include fragment ${source} at ${path}: ${causeMessage(cause)}`,
      source,
      kind: "fetch-failed",
    });
  }
};

const parseSourceRef = (raw: string): { readonly value: string; readonly ref?: string } => {
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { value: raw };
  if (raw.startsWith("git@") && raw.indexOf(":") < at) return { value: raw };
  const ref = raw.slice(at + 1);
  return ref === "" ? { value: raw } : { value: raw.slice(0, at), ref };
};

const classify = (source: string): "local" | "git" | "npm" => {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git@") || source.startsWith("github:") || /^https?:\/\//u.test(source)) return "git";
  return "local";
};

const parseGitInclude = (
  entry: NormalizedInclude,
): { readonly sourceId: string; readonly cloneUrl: string; readonly path: string; readonly ref?: string } => {
  const parsed = parseSourceRef(entry.source);
  const path = safeRelativeSubpath(entry.path ?? gitHubPathFromSource(parsed.value), entry.source);
  const ref = entry.version ?? parsed.ref;
  return {
    // Path is part of the identity so same-repo/different-path includes get distinct lock entries.
    sourceId: `${gitRepoIdentity(parsed.value)}/${path}`,
    cloneUrl: gitCloneUrl(parsed.value),
    path,
    ...(ref === undefined ? {} : { ref }),
  };
};

const gitHubPathFromSource = (source: string): string | undefined => {
  if (!source.startsWith("github:")) return undefined;
  const rest = source.slice("github:".length);
  const parts = rest.split("/");
  return parts.length > 2 ? parts.slice(2).join("/") : undefined;
};

const gitCloneUrl = (source: string): string => {
  if (!source.startsWith("github:")) return source;
  const [owner, repo] = source.slice("github:".length).split("/");
  return owner === undefined || repo === undefined ? source : `https://github.com/${owner}/${repo}.git`;
};

const gitRepoIdentity = (source: string): string => {
  if (!source.startsWith("github:")) return source;
  const [owner, repo] = source.slice("github:".length).split("/");
  return owner === undefined || repo === undefined ? source : `github:${owner}/${repo}`;
};

const parseNpmInclude = (
  entry: NormalizedInclude,
): {
  readonly sourceId: string;
  readonly packageSpec: string;
  readonly packageName: string;
  readonly requestedVersion?: string;
  readonly path: string;
} => {
  const withoutScheme = entry.source.slice("npm:".length);
  const parsed = parseSourceRef(withoutScheme);
  const requestedVersion = entry.version ?? parsed.ref;
  const parts = parsed.value.split("/");
  const packageName = parsed.value.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const subpath =
    entry.path ?? (parsed.value.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/"));
  const packageSpec = requestedVersion === undefined ? packageName : `${packageName}@${requestedVersion}`;
  parseNpmPackageSpec(packageSpec);
  return {
    sourceId: `npm:${parsed.value}`,
    packageSpec,
    packageName,
    ...(requestedVersion === undefined ? {} : { requestedVersion }),
    path: safeRelativeSubpath(subpath, entry.source),
  };
};

const fetchLocal = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const candidate = isAbsolute(entry.source) ? entry.source : resolve(ctx.appRoot, entry.source);
  const filePath = await assertUnderRoot(ctx.appRoot, candidate, entry.source);
  return {
    sourceId: filePath,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    locked: false,
  };
};

const fetchGit = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const parsed = parseGitInclude(entry);
  const gitRoot = join(ctx.cacheRoot, "includes", "git");
  await mkdir(gitRoot, { recursive: true });
  const stagingDir = await mkdtemp(join(gitRoot, ".staging-"));
  let commitSha: string;
  try {
    commitSha = (
      await (ctx.deps.gitCloner ?? defaultGitRecipeCloner).clone({
        url: parsed.cloneUrl,
        stagingDir,
        dest: stagingDir,
      })
    ).commitSha.trim();
  } catch (cause) {
    await rm(stagingDir, { recursive: true, force: true });
    throw includeError({
      message: `Could not clone include ${entry.source}: ${causeMessage(cause)}`,
      source: entry.source,
      kind: "fetch-failed",
    });
  }
  const publishedDir = join(gitRoot, commitSha);
  if (await fileExists(publishedDir)) await rm(stagingDir, { recursive: true, force: true });
  else await publish(stagingDir, publishedDir);
  const filePath = await assertUnderRoot(
    publishedDir,
    join(publishedDir, parsed.path),
    entry.source,
    "cloned repository",
  );
  return {
    sourceId: parsed.sourceId,
    resolved: commitSha,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    locked: true,
  };
};

const defaultNpmRegistryClient: NpmRegistryClient = {
  fetchPackument: async (packageName) => {
    const encoded = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);
    const response = await fetch(`https://registry.npmjs.org/${encoded}`, {
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return (await response.json()) as NpmPackument;
  },
};

const resolveNpmVersion = (
  packument: NpmPackument,
  requested: string | undefined,
  source: string,
): string => {
  const versions = packument.versions ?? {};
  const tags = packument["dist-tags"] ?? {};
  if (requested === undefined || requested === "") {
    const latest = tags.latest;
    if (latest !== undefined && versions[latest] !== undefined) return latest;
  } else {
    const tagged = tags[requested];
    if (tagged !== undefined && versions[tagged] !== undefined) return tagged;
    if (versions[requested] !== undefined) return requested;
  }
  throw includeError({
    message: `Could not resolve npm include version for ${source}.`,
    source,
    kind: "source-unresolved",
  });
};

const fetchNpm = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const parsed = parseNpmInclude(entry);
  let packument: NpmPackument | undefined;
  try {
    packument = await (ctx.deps.npmRegistryClient ?? defaultNpmRegistryClient).fetchPackument(
      parsed.packageName,
    );
  } catch (cause) {
    throw includeError({
      message: `Could not fetch npm metadata for ${parsed.packageName}: ${causeMessage(cause)}`,
      source: entry.source,
      kind: "fetch-failed",
    });
  }
  if (packument === undefined) {
    throw includeError({
      message: `npm include package ${parsed.packageName} was not found.`,
      source: entry.source,
      kind: "source-unresolved",
    });
  }
  const version = resolveNpmVersion(packument, parsed.requestedVersion, entry.source);
  const tarball = packument.versions?.[version]?.dist.tarball;
  if (tarball === undefined || tarball === "") {
    throw includeError({
      message: `npm include ${parsed.packageName}@${version} has no tarball URL.`,
      source: entry.source,
      kind: "source-unresolved",
    });
  }
  let archive: Uint8Array;
  try {
    archive = await (ctx.deps.npmFetcher ?? defaultTarballRecipeFetcher).fetch(tarball);
  } catch (cause) {
    throw includeError({
      message: `Could not download npm include ${tarball}: ${causeMessage(cause)}`,
      source: entry.source,
      kind: "fetch-failed",
    });
  }
  const npmRoot = join(ctx.cacheRoot, "includes", "npm");
  await mkdir(npmRoot, { recursive: true });
  const publishedDir = join(npmRoot, `${parsed.packageName.replace(/[^A-Za-z0-9._-]+/gu, "-")}-${version}`);
  if (!(await fileExists(publishedDir))) {
    const stagingDir = await mkdtemp(join(npmRoot, ".staging-"));
    try {
      await (ctx.deps.npmExtractor ?? defaultTarballRecipeExtractor).extract(archive, stagingDir);
      await publish(stagingDir, publishedDir);
    } catch (cause) {
      await rm(stagingDir, { recursive: true, force: true });
      throw includeError({
        message: `Could not extract npm include ${entry.source}: ${causeMessage(cause)}`,
        source: entry.source,
        kind: "fetch-failed",
      });
    }
  }
  const filePath = await assertUnderRoot(
    publishedDir,
    join(publishedDir, "package", parsed.path),
    entry.source,
    "npm package",
  );
  return {
    sourceId: parsed.sourceId,
    resolved: version,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    locked: true,
  };
};

const parseFragment = (
  fragment: FragmentResult,
): Effect.Effect<Record<string, unknown>, LandofileParseError | LandofileIncludeError> =>
  parseLandofile({ file: fragment.filePath, content: fragment.content, cwd: fragment.root }).pipe(
    Effect.flatMap((parsed) => {
      if (!isPlainRecord(parsed)) {
        return Effect.fail(
          includeError({
            message: `Include ${fragment.sourceId} did not parse to a Landofile object.`,
            source: fragment.sourceId,
            kind: "parse-failed",
          }),
        );
      }
      if (Object.hasOwn(parsed, "name") || Object.hasOwn(parsed, "runtime")) {
        return Effect.fail(
          includeError({
            message: `Include ${fragment.sourceId} must not declare top-level name: or runtime:.`,
            source: fragment.sourceId,
            kind: "forbidden-field",
          }),
        );
      }
      return Effect.succeed(parsed);
    }),
  );

const validationIssues = (cause: unknown): ReadonlyArray<string> =>
  ParseResult.isParseError(cause)
    ? ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
      )
    : [causeMessage(cause)];

const decodeMerged = (
  value: Record<string, unknown>,
  filePath: string,
): Effect.Effect<LandofileShape, LandofileParseError> => {
  const decoded = Schema.decodeUnknownEither(LandofileShape)(value, { onExcessProperty: "error" });
  if (decoded._tag === "Right") return Effect.succeed(decoded.right);
  return Effect.fail(
    new LandofileParseError({
      message: `Merged Landofile is invalid: ${validationIssues(decoded.left).join(", ")}`,
      filePath,
      line: undefined,
      column: undefined,
      cause: decoded.left,
    }),
  );
};

const inlineWithoutIncludes = (landofile: Record<string, unknown>): Record<string, unknown> => {
  const { includes: _includes, ...rest } = landofile;
  return rest;
};

const resolveTree = (
  landofile: LandofileShape,
  ctx: ResolveContext,
  depth: number,
  stack: ReadonlyArray<string>,
): Effect.Effect<LandofileShape, LandofileIncludeError | LandofileLockMismatchError | LandofileParseError> =>
  Effect.gen(function* () {
    if (depth > ctx.maxDepth) {
      return yield* Effect.fail(
        includeError({
          message: `Landofile includes exceed the maximum depth of ${ctx.maxDepth}.`,
          source: stack.at(-1) ?? "includes",
          kind: "max-depth",
        }),
      );
    }
    const includes = landofile.includes ?? [];
    if (includes.length === 0) return landofile;

    const fragments: Record<string, unknown>[] = [];
    for (const rawEntry of includes) {
      const entry = normalizeInclude(rawEntry);
      const fragment = yield* Effect.tryPromise({
        try: async () => {
          const kind = classify(entry.source);
          if (kind === "local") return fetchLocal(entry, ctx);
          if (kind === "git") return fetchGit(entry, ctx);
          return fetchNpm(entry, ctx);
        },
        catch: (cause) =>
          cause instanceof LandofileIncludeError
            ? cause
            : includeError({ message: causeMessage(cause), source: entry.source, kind: "fetch-failed" }),
      });
      if (stack.includes(fragment.sourceId)) {
        return yield* Effect.fail(
          includeError({
            message: `Landofile include cycle detected at ${entry.source}.`,
            source: entry.source,
            kind: "cycle",
          }),
        );
      }
      const parsed = yield* parseFragment(fragment);
      const nested = yield* resolveTree(parsed as LandofileShape, ctx, depth + 1, [
        ...stack,
        fragment.sourceId,
      ]);
      fragments.push(nested as Record<string, unknown>);
      if (fragment.locked && fragment.resolved !== undefined) {
        const actual = sha256(fragment.content);
        if (ctx.mode === "refresh") {
          ctx.stagedLocks.set(fragment.sourceId, {
            source: fragment.sourceId,
            resolved: fragment.resolved,
            checksum: actual,
          });
        } else {
          const locked = ctx.lockEntries.get(fragment.sourceId);
          if (locked !== undefined) {
            if (locked.checksum !== actual || locked.resolved !== fragment.resolved) {
              return yield* Effect.fail(
                new LandofileLockMismatchError({
                  message: `Landofile include lock mismatch for ${fragment.sourceId}.`,
                  lockfile: ctx.lockfilePath,
                  source: fragment.sourceId,
                  expected: `${locked.resolved}:${locked.checksum}`,
                  actual: `${fragment.resolved}:${actual}`,
                  remediation: LOCK_REMEDIATION,
                }),
              );
            }
          } else {
            ctx.stagedLocks.set(fragment.sourceId, {
              source: fragment.sourceId,
              resolved: fragment.resolved,
              checksum: actual,
            });
          }
        }
      }
    }

    const merged = mergeLandofiles([
      ...fragments,
      inlineWithoutIncludes(landofile as Record<string, unknown>),
    ]);
    return yield* decodeMerged(merged, ctx.lockfilePath);
  });

const lockScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

/**
 * Parse the on-disk `.lando.lock.yml` text into `LockEntry` records. Pure (no
 * IO): this is the body of the `StateBucket` custom codec's `decode`. Invalid
 * lockfile syntax throws so the bucket's `onCorrupt: "discard"` policy owns
 * recovery to the empty-lock default.
 */
const parseLockEntriesFromText = (content: string): LockEntry[] => {
  const parsed = parseLockfileYaml(content);
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.includes)) return [];
  const entries: LockEntry[] = [];
  for (const entry of parsed.includes) {
    if (!isPlainRecord(entry)) continue;
    const source = lockScalar(entry.source);
    const resolved = lockScalar(entry.resolved);
    const checksum = lockScalar(entry.checksum);
    if (source !== undefined && resolved !== undefined && checksum !== undefined) {
      entries.push({ source, resolved, checksum });
    }
  }
  return entries;
};

/**
 * Minimal block-style YAML reader for the lockfile's fixed shape
 * (`includes:` -> list of `source`/`resolved`/`checksum` maps). The lockfile is
 * Lando-owned and only ever emitted by `renderLockfile`, so a small line-based
 * reader is sufficient and avoids pulling the full Landofile parser into the
 * codec.
 */
const parseLockfileYaml = (content: string): { includes: Array<Record<string, unknown>> } => {
  const includes: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^includes:\s*$/u.test(line)) continue;
    const itemMatch = /^ {2}- source:\s*(.*)$/u.exec(line);
    if (itemMatch !== null) {
      current = { source: unescapeScalar(itemMatch[1] ?? "") };
      includes.push(current);
      continue;
    }
    const fieldMatch = /^ {4}(resolved|checksum):\s*(.*)$/u.exec(line);
    if (fieldMatch !== null && current !== undefined) {
      current[fieldMatch[1] as "resolved" | "checksum"] = unescapeScalar(fieldMatch[2] ?? "");
      continue;
    }
    throw new Error(`Invalid include lockfile line: ${line}`);
  }
  return { includes };
};

const unescapeScalar = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  return trimmed;
};

const escapeScalar = (value: string): string => {
  if (/^[A-Za-z0-9._~:/@+-]+$/u.test(value) && value !== "true" && value !== "false" && value !== "null")
    return value;
  return `'${value.replace(/'/gu, "''")}'`;
};

const renderLockfile = (entries: ReadonlyArray<LockEntry>): string => {
  const lines = ["# DO NOT EDIT - generated by Lando.", "includes:"];
  const byCodepoint = (left: LockEntry, right: LockEntry): number =>
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0;
  for (const entry of [...entries].sort(byCodepoint)) {
    lines.push(`  - source: ${escapeScalar(entry.source)}`);
    lines.push(`    resolved: ${escapeScalar(entry.resolved)}`);
    lines.push(`    checksum: ${entry.checksum}`);
  }
  lines.push("");
  return lines.join("\n");
};

const LockEntrySchema = Schema.Struct({
  source: Schema.String,
  resolved: Schema.String,
  checksum: Schema.String,
});
const LockEntriesSchema = Schema.Array(LockEntrySchema);

const lockfileStore = makeStateStore();
const lockTextDecoder = new TextDecoder();

/**
 * Open the `StateBucket` that owns one app's `.lando.lock.yml`. The bucket uses a
 * CUSTOM codec wrapping {@link renderLockfile} / {@link parseLockEntriesFromText}
 * so the on-disk YAML stays byte-for-byte identical, and the store provides the
 * atomic write + path containment (no direct `writeFileAtomicViaRename`). The
 * default app lockfile uses the PRD's `{ app: appRoot }` root; explicit
 * `lockfilePath` overrides pin the bucket to that path's directory.
 */
const lockfileRoot = (
  appRoot: string,
  lockfilePath: string,
): { readonly root: StateRoot; readonly key: string } => {
  const defaultLockfilePath = resolve(appRoot, ".lando.lock.yml");
  if (resolve(lockfilePath) === defaultLockfilePath) {
    return { root: { app: AbsolutePath.make(appRoot) }, key: ".lando.lock.yml" };
  }
  return { root: { path: AbsolutePath.make(dirname(lockfilePath)) }, key: basename(lockfilePath) };
};

const openLockfileBucket = (
  appRoot: string,
  lockfilePath: string,
): Effect.Effect<StateBucket<readonly LockEntry[]>, LandofileParseError> => {
  const { root, key } = lockfileRoot(appRoot, lockfilePath);
  return lockfileStore
    .open({
      root,
      key,
      schema: LockEntriesSchema,
      version: 1,
      lock: "none",
      onCorrupt: "discard",
      default: [],
      codec: {
        encode: (entries) => renderLockfile(entries),
        decode: (raw) => parseLockEntriesFromText(lockTextDecoder.decode(raw)),
      },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new LandofileParseError({
            message: `Failed to open include lockfile ${lockfilePath}: ${causeMessage(cause)}`,
            filePath: lockfilePath,
            line: undefined,
            column: undefined,
            cause,
          }),
      ),
    );
};

const parseLockEntries = (
  appRoot: string,
  path: string,
): Effect.Effect<ReadonlyMap<string, LockEntry>, LandofileParseError> =>
  openLockfileBucket(appRoot, path).pipe(
    Effect.flatMap((bucket) =>
      bucket.get.pipe(
        Effect.mapError(
          (cause) =>
            new LandofileParseError({
              message: `Failed to read include lockfile ${path}: ${causeMessage(cause)}`,
              filePath: path,
              line: undefined,
              column: undefined,
              cause,
            }),
        ),
      ),
    ),
    Effect.map((entries) => {
      const map = new Map<string, LockEntry>();
      for (const entry of entries ?? []) map.set(entry.source, entry);
      return map;
    }),
  );

const writeLockEntries = (
  appRoot: string,
  lockfilePath: string,
  entries: ReadonlyArray<LockEntry>,
): Effect.Effect<void, LandofileIncludeError> =>
  openLockfileBucket(appRoot, lockfilePath).pipe(
    Effect.flatMap((bucket) => bucket.set(entries)),
    Effect.mapError(() =>
      includeError({
        message: `Could not write include lockfile ${lockfilePath}.`,
        source: lockfilePath,
        kind: "fetch-failed",
      }),
    ),
  );

const writeLockfileIfNeeded = (ctx: ResolveContext): Effect.Effect<void, LandofileIncludeError> => {
  if (ctx.stagedLocks.size === 0) return Effect.void;
  const merged = new Map(ctx.lockEntries);
  for (const [source, entry] of ctx.stagedLocks) merged.set(source, entry);
  return writeLockEntries(ctx.appRoot, ctx.lockfilePath, [...merged.values()]);
};

export const resolveLandofileIncludes = (
  options: ResolveLandofileIncludesOptions,
): Effect.Effect<
  LandofileShape,
  LandofileIncludeError | LandofileLockMismatchError | LandofileParseError,
  never
> => {
  if (options.landofile.includes === undefined || options.landofile.includes.length === 0) {
    return Effect.succeed(options.landofile);
  }

  return Effect.gen(function* () {
    const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
    const ctx: ResolveContext = {
      appRoot: options.appRoot,
      cacheRoot: options.cacheRoot ?? resolveUserCacheRoot(),
      lockfilePath,
      deps: options.deps ?? {},
      maxDepth: options.maxDepth ?? 8,
      mode: "pin",
      lockEntries: yield* parseLockEntries(options.appRoot, lockfilePath),
      stagedLocks: new Map(),
    };
    const resolved = yield* resolveTree(options.landofile, ctx, 0, [options.appRoot]);
    yield* writeLockfileIfNeeded(ctx);
    return resolved;
  });
};

export type IncludeUpdateStatus = "added" | "updated" | "unchanged";

export interface IncludeUpdateEntry {
  readonly source: string;
  readonly resolved: string;
  readonly checksum: string;
  readonly status: IncludeUpdateStatus;
}

export interface IncludeUpdateReport {
  readonly lockfilePath: string;
  readonly entries: ReadonlyArray<IncludeUpdateEntry>;
  readonly removed: ReadonlyArray<string>;
  readonly drift: boolean;
  readonly wrote: boolean;
  readonly checkMode: boolean;
}

export interface UpdateLandofileIncludesOptions {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
  readonly check?: boolean;
}

const byCodepointString = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const updateLandofileIncludes = (
  options: UpdateLandofileIncludesOptions,
): Effect.Effect<
  IncludeUpdateReport,
  LandofileIncludeError | LandofileLockMismatchError | LandofileParseError,
  never
> =>
  Effect.gen(function* () {
    const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
    const checkMode = options.check === true;
    const existing = yield* parseLockEntries(options.appRoot, lockfilePath);
    const includes = options.landofile.includes ?? [];

    const ctx: ResolveContext = {
      appRoot: options.appRoot,
      cacheRoot: options.cacheRoot ?? resolveUserCacheRoot(),
      lockfilePath,
      deps: options.deps ?? {},
      maxDepth: options.maxDepth ?? 8,
      mode: "refresh",
      lockEntries: existing,
      stagedLocks: new Map(),
    };

    if (includes.length > 0) {
      yield* resolveTree(options.landofile, ctx, 0, [options.appRoot]);
    }

    const entries: IncludeUpdateEntry[] = [...ctx.stagedLocks.values()]
      .sort((left, right) => byCodepointString(left.source, right.source))
      .map((entry) => {
        const prev = existing.get(entry.source);
        const status: IncludeUpdateStatus =
          prev === undefined
            ? "added"
            : prev.resolved !== entry.resolved || prev.checksum !== entry.checksum
              ? "updated"
              : "unchanged";
        return { source: entry.source, resolved: entry.resolved, checksum: entry.checksum, status };
      });
    const removed = [...existing.keys()]
      .filter((source) => !ctx.stagedLocks.has(source))
      .sort(byCodepointString);
    const drift = entries.some((entry) => entry.status !== "unchanged") || removed.length > 0;

    let wrote = false;
    if (!checkMode && drift) {
      yield* writeLockEntries(options.appRoot, lockfilePath, [...ctx.stagedLocks.values()]);
      wrote = true;
    }

    return { lockfilePath, entries, removed, drift, wrote, checkMode };
  });

export type IncludeVerifyStatus = "ok" | "mismatch" | "missing" | "stale";

export interface IncludeVerifyEntry {
  readonly source: string;
  readonly status: IncludeVerifyStatus;
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface IncludeVerifyMismatch {
  readonly _tag: "LandofileLockMismatchError";
  readonly message: string;
  readonly lockfile: string;
  readonly source: string;
  readonly expected: string;
  readonly actual: string;
  readonly remediation: string;
}

export interface IncludeVerifyReport {
  readonly lockfilePath: string;
  readonly entries: ReadonlyArray<IncludeVerifyEntry>;
  readonly mismatches: ReadonlyArray<IncludeVerifyMismatch>;
  readonly ok: boolean;
}

export interface VerifyLandofileIncludesOptions {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
}

const MISSING_LOCK_VALUE = "<missing>";

const lockValue = (entry: LockEntry): string => `${entry.resolved}:${entry.checksum}`;

const encodeLockMismatch = Schema.encodeSync(LandofileLockMismatchError);

const verifyMismatchMessage = (source: string, status: IncludeVerifyStatus): string => {
  if (status === "missing") return `Landofile include ${source} is not recorded in the lockfile.`;
  if (status === "stale") return `Lockfile entry ${source} no longer matches a resolved include.`;
  return `Landofile include lock mismatch for ${source}.`;
};

/**
 * Read-only verification that `.lando.lock.yml` matches the resolved include
 * tree. Re-resolves every fragment via the refresh-mode machinery but never
 * writes the lockfile and never fails the effect on drift: each fragment's
 * status (and any mismatch, in the `LandofileLockMismatchError` schema) is
 * returned as data so callers can render the full picture and gate on exit code.
 */
export const verifyLandofileIncludes = (
  options: VerifyLandofileIncludesOptions,
): Effect.Effect<
  IncludeVerifyReport,
  LandofileIncludeError | LandofileLockMismatchError | LandofileParseError,
  never
> =>
  Effect.gen(function* () {
    const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
    const existing = yield* parseLockEntries(options.appRoot, lockfilePath);
    const includes = options.landofile.includes ?? [];

    const ctx: ResolveContext = {
      appRoot: options.appRoot,
      cacheRoot: options.cacheRoot ?? resolveUserCacheRoot(),
      lockfilePath,
      deps: options.deps ?? {},
      maxDepth: options.maxDepth ?? 8,
      mode: "refresh",
      lockEntries: existing,
      stagedLocks: new Map(),
    };

    if (includes.length > 0) {
      yield* resolveTree(options.landofile, ctx, 0, [options.appRoot]);
    }

    const staged = ctx.stagedLocks;
    const sources = [...new Set([...existing.keys(), ...staged.keys()])].sort(byCodepointString);

    const entries: IncludeVerifyEntry[] = [];
    const mismatches: IncludeVerifyMismatch[] = [];
    for (const source of sources) {
      const lock = existing.get(source);
      const fresh = staged.get(source);
      const expected = lock === undefined ? null : lockValue(lock);
      const actual = fresh === undefined ? null : lockValue(fresh);
      const status: IncludeVerifyStatus =
        lock !== undefined && fresh !== undefined
          ? lock.resolved === fresh.resolved && lock.checksum === fresh.checksum
            ? "ok"
            : "mismatch"
          : fresh !== undefined
            ? "missing"
            : "stale";
      entries.push({ source, status, expected, actual });
      if (status !== "ok") {
        mismatches.push(
          encodeLockMismatch(
            new LandofileLockMismatchError({
              message: verifyMismatchMessage(source, status),
              lockfile: lockfilePath,
              source,
              expected: expected ?? MISSING_LOCK_VALUE,
              actual: actual ?? MISSING_LOCK_VALUE,
              remediation: LOCK_REMEDIATION,
            }),
          ),
        );
      }
    }

    return { lockfilePath, entries, mismatches, ok: mismatches.length === 0 };
  });
