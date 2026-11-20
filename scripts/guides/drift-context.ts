import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

export interface DriftContext {
  readonly changedFiles: readonly string[];
  readonly prBody: string;
  readonly baseRef?: string;
}

const splitFileList = (value: string): readonly string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const gitChangedFiles = (args: readonly string[]): readonly string[] | undefined => {
  const result = Bun.spawnSync({
    cmd: ["git", "diff", "--name-only", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.success ? splitFileList(result.stdout.toString()) : undefined;
};

export const resolveDriftContext = (env: NodeJS.ProcessEnv = process.env): DriftContext | undefined => {
  const prBody = env.GUIDE_DRIFT_PR_BODY ?? "";
  const baseSha = env.GUIDE_DRIFT_BASE_SHA;
  const headSha = env.GUIDE_DRIFT_HEAD_SHA;
  const baseRef = env.GUIDE_DRIFT_BASE_REF;
  const explicit = env.GUIDE_DRIFT_CHANGED_FILES;
  if (explicit !== undefined) {
    const base = baseSha || baseRef;
    return { changedFiles: splitFileList(explicit), prBody, ...(base ? { baseRef: base } : {}) };
  }
  if (baseSha && headSha) {
    const files = gitChangedFiles([baseSha, headSha]);
    if (files !== undefined) return { changedFiles: files, prBody, baseRef: baseSha };
  }
  if (baseRef) {
    const files = gitChangedFiles(["--merge-base", baseRef, "HEAD"]);
    if (files !== undefined) return { changedFiles: files, prBody, baseRef };
  }
  const base = baseRef || baseSha;
  return base ? { changedFiles: [], prBody, baseRef: base } : undefined;
};
