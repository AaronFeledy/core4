/**
 * Resolve the version stamped into compiled `lando` binaries.
 *
 * Working-tree `package.json` stays at `0.0.0` until publish. Compiled artifacts
 * that users download must never report that placeholder: `--version` and
 * `lando doctor` share this stamp.
 *
 * Tags are optional. Existing CI checkouts already use `fetch-depth: 0`; if tags
 * were not fetched, this resolver still derives a real 4.x prerelease from the
 * commit SHA instead of requiring `fetch-tags: true`.
 */
const PLACEHOLDER_CORE_VERSION = "0.0.0";
const DEFAULT_DEV_SERIES = "4.0.0-dev";
const GIT_DESCRIBE_ARGS = ["describe", "--tags", "--always", "--dirty", "--match", "v[0-9]*"] as const;
const BARE_SHA_PATTERN = /^(?:g)?([0-9a-f]{7,40})$/i;
const SEMVER_LIKE_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class CompiledBinaryVersionError extends Error {
  override readonly name = "CompiledBinaryVersionError";
}

export interface ResolveCompiledBinaryVersionInput {
  readonly explicit?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly describe?: () => string | undefined;
  readonly revParse?: () => string | undefined;
  readonly cwd?: string;
}

const trimVersion = (value: string): string => value.trim().replace(/\r/g, "");

export const isPlaceholderCoreVersion = (version: string): boolean => {
  const normalized = trimVersion(version).replace(/^v/i, "");
  return (
    normalized === PLACEHOLDER_CORE_VERSION ||
    normalized.startsWith(`${PLACEHOLDER_CORE_VERSION}-`) ||
    normalized.startsWith(`${PLACEHOLDER_CORE_VERSION}+`)
  );
};

const describeSuffix = (
  value: string,
): { readonly rest: string; readonly commits?: string; readonly sha?: string; readonly dirty: boolean } => {
  let rest = value;
  let dirty = false;
  if (rest.endsWith("-dirty")) {
    dirty = true;
    rest = rest.slice(0, -"-dirty".length);
  }
  const match = /-(\d+)-g([0-9a-f]+)$/i.exec(rest);
  if (match?.index === undefined) return { rest, dirty };
  return {
    rest: rest.slice(0, match.index),
    commits: match[1],
    sha: match[2],
    dirty,
  };
};

const withMetadata = (base: string, parts: ReadonlyArray<string | undefined>): string => {
  const metadata = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return metadata.length === 0 ? base : `${base}+${metadata.join(".")}`;
};

export const normalizeCompiledBinaryVersion = (raw: string): string => {
  const trimmed = trimVersion(raw);
  if (trimmed === "") {
    throw new CompiledBinaryVersionError("Compiled binary version must not be empty.");
  }

  const described = describeSuffix(trimmed);
  const base = described.rest.replace(/^v/, "");
  if (SEMVER_LIKE_PATTERN.test(base)) {
    return withMetadata(base, [
      described.commits === undefined || described.sha === undefined
        ? undefined
        : `${described.commits}.g${described.sha}`,
      described.dirty ? "dirty" : undefined,
    ]);
  }

  const shaSource = described.rest.replace(/^g/i, "");
  const sha = BARE_SHA_PATTERN.exec(shaSource)?.[1];
  if (sha !== undefined) {
    return withMetadata(DEFAULT_DEV_SERIES, [sha, described.dirty ? "dirty" : undefined]);
  }

  return trimmed.replace(/^v/, "");
};

const readEnvVersion = (env: NodeJS.ProcessEnv): string | undefined => {
  for (const key of ["LANDO_RELEASE_VERSION", "LANDO_CORE_VERSION"] as const) {
    const value = env[key];
    if (value !== undefined && trimVersion(value) !== "") return value;
  }
  return undefined;
};

const decodeStdout = (stdout: Uint8Array): string | undefined => {
  const trimmed = trimVersion(new TextDecoder().decode(stdout));
  return trimmed === "" ? undefined : trimmed;
};

const spawnGitDescribe = (cwd: string): string | undefined => {
  const proc = Bun.spawnSync({
    cmd: ["git", ...GIT_DESCRIBE_ARGS],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return undefined;
  return decodeStdout(proc.stdout);
};

const spawnGitRevParse = (cwd: string): string | undefined => {
  const proc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--short=12", "HEAD"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return undefined;
  return decodeStdout(proc.stdout);
};

const acceptResolved = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const normalized = normalizeCompiledBinaryVersion(raw);
  return isPlaceholderCoreVersion(normalized) ? undefined : normalized;
};

export const resolveCompiledBinaryVersion = (input: ResolveCompiledBinaryVersionInput = {}): string => {
  const env = input.env ?? process.env;
  const candidates = [input.explicit, readEnvVersion(env)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const normalized = normalizeCompiledBinaryVersion(candidate);
    if (isPlaceholderCoreVersion(normalized)) {
      throw new CompiledBinaryVersionError(
        `Refusing to stamp compiled binary with placeholder version ${normalized}.`,
      );
    }
    return normalized;
  }

  const cwd = input.cwd ?? process.cwd();
  // Provided hooks win even when they return undefined, so tests can simulate
  // a checkout with no tags and CI without fetch-tags without hitting the
  // real worktree.
  const describedRaw = input.describe !== undefined ? input.describe() : spawnGitDescribe(cwd);
  const described = acceptResolved(describedRaw);
  if (described !== undefined) return described;

  // No matching tag (shallow CI checkout without fetch-tags, or describe failed).
  // Stamp a real 4.x prerelease from the commit SHA instead of 0.0.0.
  const shaRaw = input.revParse !== undefined ? input.revParse() : spawnGitRevParse(cwd);
  const sha = acceptResolved(shaRaw);
  if (sha !== undefined) return sha;

  throw new CompiledBinaryVersionError(
    "Unable to resolve a non-placeholder 4.x version for the compiled binary. Pass --version, set LANDO_CORE_VERSION, or run from a git checkout.",
  );
};

export const assertCompiledBinaryVersion = (version: string): string => {
  const trimmed = trimVersion(version);
  if (trimmed === "" || isPlaceholderCoreVersion(trimmed)) {
    throw new CompiledBinaryVersionError(
      `compiled binary reported placeholder version: ${trimmed === "" ? "(empty)" : trimmed}`,
    );
  }
  return trimmed;
};
