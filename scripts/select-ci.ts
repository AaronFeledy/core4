import { appendFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { type CiSelection, selectPaths } from "./ci-selection.ts";

export class CiGitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`);
  }
}

const git = (cwd: string, args: readonly string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

export const selectCi = (input: {
  readonly event: string;
  readonly base: string;
  readonly head: string;
  readonly cwd: string;
}): CiSelection => {
  if (input.event !== "pull_request") return { profile: "runtime", broad: true, reason: "broad event" };
  const fallback = (reason: string): CiSelection => ({ profile: "providers", broad: false, reason });
  if (![input.base, input.head].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)))
    return fallback("missing or unusable SHAs");
  const repoArgs = ["rev-parse", "--git-dir"];
  const repo = git(input.cwd, repoArgs);
  if (repo.code !== 0) throw new CiGitError(repoArgs, repo.code, repo.stderr);
  for (const sha of [input.base, input.head]) {
    const args = ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`];
    const result = git(input.cwd, args);
    if (result.code === 1) return fallback("missing commit history");
    if (result.code !== 0) throw new CiGitError(args, result.code, result.stderr);
  }
  const mergeArgs = ["merge-base", input.base, input.head];
  const merge = git(input.cwd, mergeArgs);
  if (merge.code === 1) return fallback("missing merge base");
  if (merge.code !== 0) throw new CiGitError(mergeArgs, merge.code, merge.stderr);
  const args = ["diff", "--name-only", "-z", "--no-renames", merge.stdout.trim(), input.head, "--"];
  const diff = git(input.cwd, args);
  if (diff.code !== 0) throw new CiGitError(args, diff.code, diff.stderr);
  return selectPaths(diff.stdout.split("\0").filter(Boolean));
};

if (import.meta.main) {
  const env = Schema.decodeUnknownSync(
    Schema.Struct({
      GITHUB_EVENT_NAME: Schema.String,
      CI_BASE_SHA: Schema.optional(Schema.String),
      CI_HEAD_SHA: Schema.optional(Schema.String),
      GITHUB_OUTPUT: Schema.optional(Schema.String),
    }),
  )(process.env);
  const selection = selectCi({
    event: env.GITHUB_EVENT_NAME,
    base: env.CI_BASE_SHA ?? "",
    head: env.CI_HEAD_SHA ?? "",
    cwd: process.cwd(),
  });
  console.log(JSON.stringify(selection));
  if (env.GITHUB_OUTPUT)
    await appendFile(
      env.GITHUB_OUTPUT,
      `profile=${selection.profile}\nbroad=${selection.broad}\nreason=${selection.reason}\n`,
    );
}
