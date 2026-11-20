import { resolve } from "node:path";
import { Schema } from "effect";

export const CONTAINER_COMMAND_BASELINE_PATH = "scripts/guides/container-command-baseline.json";
export const CONTAINER_COMMAND_CODE = "guide.container-command.e2e-coverage";
export const CONTAINER_COMMAND_WAIVER = "{/* lando-lint: not-e2e <reason> */}";
const rulePath = "scripts/guides/container-command-lint.ts";
const baselineSchema = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type ContainerCommandBaseline = typeof baselineSchema.Type;
export const decodeContainerCommandBaseline = Schema.decodeUnknownSync(baselineSchema);

type BaselineEntry = { readonly path: string; readonly command: string };

export const addedContainerCommandEntries = (
  base: ContainerCommandBaseline,
  current: ContainerCommandBaseline,
  removedPaths: ReadonlySet<string>,
): readonly BaselineEntry[] => {
  const carry = new Map<string, number>();
  const prior = new Map(Object.entries(base).map(([path, commands]) => [path, new Set(commands)]));
  for (const [path, commands] of prior) {
    if (!removedPaths.has(path)) continue;
    const retained = new Set(Object.hasOwn(current, path) ? current[path] : []);
    for (const command of commands) {
      if (!retained.has(command)) carry.set(command, (carry.get(command) ?? 0) + 1);
    }
  }

  const added: BaselineEntry[] = [];
  for (const [path, commands] of Object.entries(current)) {
    for (const command of new Set(commands)) {
      if (prior.get(path)?.has(command)) continue;
      const remaining = carry.get(command) ?? 0;
      if (remaining > 0) carry.set(command, remaining - 1);
      else added.push({ path, command });
    }
  }
  return added;
};

class BaselineGitError extends Error {
  constructor(args: readonly string[], detail: string) {
    super(`Could not read container command baseline from Git (git ${args.join(" ")}): ${detail}`);
  }
}

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new BaselineGitError(args, result.stderr.toString().trim());
  return result.stdout.toString();
};

export const checkContainerCommandBaselineOnDisk = async (root: string, baseRef: string) => {
  const revision = git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).trim();
  const paths = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    CONTAINER_COMMAND_BASELINE_PATH,
    rulePath,
  ]).split(/\r?\n/);
  const hasBaseline = paths.includes(CONTAINER_COMMAND_BASELINE_PATH);
  if (!hasBaseline && !paths.includes(rulePath)) return { bootstrap: true, diagnostics: [] };

  const base = hasBaseline
    ? decodeContainerCommandBaseline(
        JSON.parse(git(root, ["show", `${revision}:${CONTAINER_COMMAND_BASELINE_PATH}`])),
      )
    : {};
  const file = Bun.file(resolve(root, CONTAINER_COMMAND_BASELINE_PATH));
  const current = (await file.exists()) ? decodeContainerCommandBaseline(await file.json()) : {};
  const removedPaths = new Set<string>();
  for (const path of Object.keys(base)) {
    if (!(await Bun.file(resolve(root, path)).exists())) removedPaths.add(path);
  }
  return {
    bootstrap: false,
    diagnostics: addedContainerCommandEntries(base, current, removedPaths).map(({ path, command }) => ({
      sourcePath: CONTAINER_COMMAND_BASELINE_PATH,
      code: CONTAINER_COMMAND_CODE,
      message: `${path}: \`${/[\r\n]/.test(command) ? JSON.stringify(command) : command}\` was added to the baseline. Run it in an e2e scenario on the page or waive the fence with ${CONTAINER_COMMAND_WAIVER}; the baseline only shrinks.`,
    })),
  };
};
