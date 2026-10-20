import { stat } from "node:fs/promises";

import { Effect } from "effect";

export const STDOUT_DUMP_PATH = "/dev/stdout";
export const STDIN_DUMP_PATH = "/dev/stdin";

const STDOUT_NAMES = new Set(["-", STDOUT_DUMP_PATH, "/dev/fd/1", "/proc/self/fd/1"]);
const STDIN_NAMES = new Set(["-", STDIN_DUMP_PATH, "/dev/fd/0", "/proc/self/fd/0"]);

export const isStdoutDumpArg = (file: string | undefined): boolean =>
  file !== undefined && STDOUT_NAMES.has(file);

export const isStdinDumpArg = (file: string | undefined): boolean =>
  file !== undefined && STDIN_NAMES.has(file);

export const resolveStdioDumpPath = (file: string, role: "stdout" | "stdin"): string => {
  if (file !== "-") return file;
  return role === "stdout" ? STDOUT_DUMP_PATH : STDIN_DUMP_PATH;
};

export const isNonRegularExistingPath = (path: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const info = await stat(path);
      return !info.isFile() && !info.isDirectory();
    } catch {
      return false;
    }
  });
