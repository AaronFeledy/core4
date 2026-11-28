import { Schema } from "effect";

/**
 * One reader for "what changed" shared by the guide-drift gate and
 * `test:affected`. Every git failure is a `GitChangeError` so a gate can never
 * fall through to an empty change set and report a pass.
 */
export class GitChangeError extends Schema.TaggedError<GitChangeError>()("GitChangeError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
  remediation: Schema.String,
}) {}

export type ChangeComparison =
  | { readonly kind: "working-tree"; readonly baseRef: string }
  | { readonly kind: "commits"; readonly base: string; readonly head: string };

export interface DiscoveredChanges {
  /** Resolved commit of the base ref or base SHA. */
  readonly base: string;
  readonly mergeBase: string;
  /** Undefined in working-tree mode: the working tree is the head. */
  readonly head?: string;
  readonly paths: readonly string[];
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGit = async (root: string, args: readonly string[]): Promise<GitResult> => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

const isMissingRepository = (stderr: string): boolean => /not a git repository/i.test(stderr);

const gitFailure = (args: readonly string[], result: GitResult, remediation: string): GitChangeError =>
  new GitChangeError({
    message: `git ${args.join(" ")} failed with exit code ${result.code}: ${
      result.stderr.trim() || result.stdout.trim() || "(no output)"
    }`,
    command: `git ${args.join(" ")}`,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    remediation,
  });

const requireGit = async (root: string, args: readonly string[], remediation: string): Promise<string> => {
  const result = await runGit(root, args);
  if (result.code !== 0) throw gitFailure(args, result, remediation);
  return result.stdout;
};

const commitRemediation = (role: "base" | "head"): string =>
  role === "base"
    ? "Fetch the base ref (git fetch origin main) or pass one that exists in this checkout: --base <ref> locally, GUIDE_DRIFT_BASE_REF or GUIDE_DRIFT_BASE_SHA in CI."
    : "The head commit is not in this checkout. Fetch full history (actions/checkout with fetch-depth: 0) so both sides of the comparison are present, and pass a commit SHA, not a ref name, as GUIDE_DRIFT_HEAD_SHA.";

export const resolveCommit = async (root: string, ref: string, role: "base" | "head"): Promise<string> => {
  const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
  const result = await runGit(root, args);
  const resolved = result.stdout.trim();
  if (result.code === 0 && resolved !== "") return resolved;
  const remediation = isMissingRepository(result.stderr)
    ? "Run this command from inside a git checkout: the working directory is not a git work tree."
    : commitRemediation(role);
  throw gitFailure(args, result, remediation);
};

export const resolveMergeBase = async (root: string, left: string, right: string): Promise<string> => {
  const args = ["merge-base", left, right];
  const result = await runGit(root, args);
  const mergeBase = result.stdout.trim();
  if (result.code === 0 && mergeBase !== "") return mergeBase;
  throw gitFailure(
    args,
    result,
    isMissingRepository(result.stderr)
      ? "Run this command from inside a git checkout: the working directory is not a git work tree."
      : "Both sides of the comparison must exist in this checkout and share an ancestor; fetch the base ref with git fetch origin main.",
  );
};

const normalize = (path: string): string => path.replaceAll("\\", "/");

/** Names from `--name-status -z`: both sides of a rename or copy are kept. */
const parseNameStatus = (output: string): readonly string[] => {
  const fields = output.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (status === undefined || status === "") break;
    const first = fields[index++];
    if (first === undefined) throw new Error("malformed git name-status output");
    paths.add(normalize(first));
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index++];
      if (second === undefined) throw new Error("malformed git rename output");
      paths.add(normalize(second));
    }
  }
  return [...paths].sort();
};

const changedBetween = async (
  root: string,
  from: string,
  to: string | undefined,
): Promise<readonly string[]> => {
  const args =
    to === undefined
      ? ["diff", "--name-status", "-z", "--find-renames", from, "--"]
      : ["diff", "--name-status", "-z", "--find-renames", from, to, "--"];
  const output = await requireGit(
    root,
    args,
    "The comparison failed. Fetch the base ref and full history (fetch-depth: 0) before retrying.",
  );
  return parseNameStatus(output);
};

export const discoverChanges = async (
  root: string,
  comparison: ChangeComparison,
): Promise<DiscoveredChanges> => {
  if (comparison.kind === "commits") {
    const base = await resolveCommit(root, comparison.base, "base");
    const head = await resolveCommit(root, comparison.head, "head");
    const mergeBase = await resolveMergeBase(root, base, head);
    return { base, mergeBase, head, paths: await changedBetween(root, mergeBase, head) };
  }
  const base = await resolveCommit(root, comparison.baseRef, "base");
  const mergeBase = await resolveMergeBase(root, "HEAD", base);
  const tracked = await changedBetween(root, mergeBase, undefined);
  const untracked = await requireGit(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Listing untracked files failed; run this inside the repository checkout.",
  );
  const paths = new Set(tracked);
  for (const path of untracked.split("\0")) if (path !== "") paths.add(normalize(path));
  return { base, mergeBase, paths: [...paths].sort() };
};

export const listGitVisibleFiles = async (root: string): Promise<readonly string[]> => {
  const output = await requireGit(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    "Listing repository files failed; run this inside the repository checkout.",
  );
  const paths = new Set<string>();
  for (const path of output.split("\0")) if (path !== "") paths.add(normalize(path));
  return [...paths].sort();
};

const blobObjectId = (listing: string, path: string): string | undefined => {
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || object === undefined || mode === undefined) continue;
    if (normalize(entry.slice(tab + 1)) === normalize(path)) return object;
  }
  return undefined;
};

/**
 * Text of `path` at `commit`, or undefined when it is not a blob there. The
 * `ls-tree` probe separates "absent at this commit" from a real git failure,
 * which `git show <commit>:<path>` cannot.
 */
export const readFileAtCommit = async (
  root: string,
  commit: string,
  path: string,
): Promise<string | undefined> => {
  const args = ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path];
  const listing = await requireGit(root, args, commitRemediation("base"));
  const object = blobObjectId(listing, path);
  if (object === undefined) return undefined;
  return requireGit(
    root,
    ["cat-file", "blob", object],
    "Reading the file's historical bytes failed; fetch full history (fetch-depth: 0).",
  );
};
