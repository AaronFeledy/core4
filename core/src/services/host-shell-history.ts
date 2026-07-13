import { readFile } from "node:fs/promises";
import { Effect } from "effect";

import { writeFileAtomicScoped } from "../state-store/atomic.ts";

export const DEFAULT_SHELL_HISTORY_LIMIT = 1000;

export const readShellHistory = async (path: string): Promise<ReadonlyArray<string>> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
};

export const writeShellHistory = async (
  path: string,
  lines: ReadonlyArray<string>,
  limit: number,
): Promise<void> => {
  const bounded = lines.slice(-limit);
  const content = bounded.length === 0 ? "" : `${bounded.join("\n")}\n`;
  await Effect.runPromise(writeFileAtomicScoped(path, content, { mode: 0o600 }));
};
