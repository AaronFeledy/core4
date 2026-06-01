import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const writeFormattedOutput = async (path: string, content: string): Promise<void> => {
  await Bun.write(path, content);

  const check = Bun.spawn({
    cmd: [process.execPath, "x", "biome", "check", "--write", "--no-errors-on-unmatched", path],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await check.exited;
  if (exitCode !== 0) {
    throw new Error(`biome check exited with code ${exitCode} for ${path}`);
  }
};
