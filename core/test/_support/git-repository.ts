import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type GitRepositoryStep =
  | { readonly kind: "commit"; readonly files: Readonly<Record<string, string>>; readonly message: string }
  | { readonly kind: "git"; readonly args: readonly string[] };

export interface GitRepository {
  readonly bare: string;
  readonly commits: readonly string[];
  /** Apply more commits/refs and publish them to the same served bare repository. */
  readonly advance: (steps: readonly GitRepositoryStep[]) => Promise<readonly string[]>;
}

/** All fixture Git processes ignore host config, hooks, signing, and line-ending preferences. */
export const runFixtureGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-c", "core.autocrlf=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Lando Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Lando Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Fixture git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
};

/** The caller owns root and its cleanup. Script Git steps can create tags, branches, or switch branches. */
export const createGitRepository = async (
  root: string,
  repoName: string,
  steps: readonly GitRepositoryStep[],
): Promise<GitRepository> => {
  const worktree = join(root, `${repoName}-worktree`);
  const bare = join(root, repoName);
  await mkdir(worktree, { recursive: true });
  await runFixtureGit(root, ["init", "-q", "--bare", "--initial-branch=main", bare]);
  await runFixtureGit(worktree, ["init", "-q", "--initial-branch=main"]);
  const advance = async (script: readonly GitRepositoryStep[]): Promise<readonly string[]> => {
    const commits: string[] = [];
    for (const step of script) {
      switch (step.kind) {
        case "commit":
          for (const [path, bytes] of Object.entries(step.files)) {
            const target = join(worktree, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, bytes);
          }
          await runFixtureGit(worktree, ["add", "."]);
          await runFixtureGit(worktree, ["commit", "-q", "--no-gpg-sign", "-m", step.message]);
          commits.push(await runFixtureGit(worktree, ["rev-parse", "HEAD"]));
          break;
        case "git":
          await runFixtureGit(worktree, step.args);
          break;
        default:
          throw new Error(`Unknown fixture step: ${step satisfies never}`);
      }
    }
    await runFixtureGit(worktree, ["push", "-q", "--mirror", bare]);
    return commits;
  };
  return { bare, commits: await advance(steps), advance };
};
