import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonicalRoot = (root: string): string => {
  try {
    return realpathSync(root);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return resolve(root);
  }
};

/** Decode only the literal single-quoted form emitted by shellenv, never evaluate shell input. */
const blockRoot = (block: string): string | undefined => {
  const lines = block.split(/\r?\n/u).filter((line) => line.startsWith("export LANDO_USER_DATA_ROOT="));
  if (lines.length !== 1) return undefined;
  const value = lines[0]?.slice("export LANDO_USER_DATA_ROOT=".length);
  if (value === undefined || !/^'[^']*'(?:"'"'[^']*')*$/u.test(value)) return undefined;
  const root = value.slice(1, -1).replaceAll(`'"'"'`, "'");
  return root.length === 0 || root.includes("\0") ? undefined : root;
};

export const inspectShellenvBlocks = (content: string, userDataRoot: string) => {
  const owner = canonicalRoot(userDataRoot);
  const foreignRoots: string[] = [];
  let manual = false;
  let found = false;
  let stripped = false;
  const rewritten = content.replace(
    /^# >>> LANDO4 shellenv >>>\r?\n[\s\S]*?^# <<< LANDO4 shellenv <<<(?:\r?\n|$)/gmu,
    (block) => {
      found = true;
      const root = blockRoot(block);
      if (root === undefined) {
        manual = true;
        return block;
      }
      if (canonicalRoot(root) !== owner) {
        foreignRoots.push(root);
        return block;
      }
      stripped = true;
      return "";
    },
  );
  return { content: rewritten, stripped, found, manual, foreignRoots };
};
