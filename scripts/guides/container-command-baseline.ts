import { resolve } from "node:path";
import { Schema } from "effect";

import { readFileAtCommit, resolveCommit } from "../git-changes.ts";

export const CONTAINER_COMMAND_BASELINE_PATH = "scripts/guides/container-command-baseline.json";
export const CONTAINER_COMMAND_CODE = "guide.container-command.e2e-coverage";
export const CONTAINER_COMMAND_WAIVER = "{/* lando-lint: not-e2e <reason> */}";
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

/**
 * Reads the baseline at `baseRef` through the shared change reader, so a git
 * failure is a `GitChangeError` with a remediation like every other one.
 */
export const checkContainerCommandBaselineOnDisk = async (root: string, baseRef: string) => {
  const revision = await resolveCommit(root, baseRef, "base");
  const baseText = await readFileAtCommit(root, revision, CONTAINER_COMMAND_BASELINE_PATH);
  // A base without a baseline is an empty baseline: the comparison stays fail-closed.
  const base = baseText === undefined ? {} : decodeContainerCommandBaseline(JSON.parse(baseText));
  const file = Bun.file(resolve(root, CONTAINER_COMMAND_BASELINE_PATH));
  const current = (await file.exists()) ? decodeContainerCommandBaseline(await file.json()) : {};
  const removedPaths = new Set<string>();
  for (const path of Object.keys(base)) {
    if (!(await Bun.file(resolve(root, path)).exists())) removedPaths.add(path);
  }
  return {
    diagnostics: addedContainerCommandEntries(base, current, removedPaths).map(({ path, command }) => ({
      sourcePath: CONTAINER_COMMAND_BASELINE_PATH,
      code: CONTAINER_COMMAND_CODE,
      message: `${path}: \`${/[\r\n]/.test(command) ? JSON.stringify(command) : command}\` was added to the baseline. Run it in an e2e scenario on the page or waive the fence with ${CONTAINER_COMMAND_WAIVER}; the total never grows, though an entry may move with its page when that page is removed.`,
    })),
  };
};
