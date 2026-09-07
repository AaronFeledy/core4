import { resolve } from "node:path";
import config from "../tsconfig.json";

export const typecheck = async (
  args: ReadonlyArray<string>,
  run: (args: ReadonlyArray<string>) => Promise<number>,
): Promise<number> => {
  const projects = config.references.map(({ path }) => path);
  // Release the package compiler's heap before checking the aggregate test graph.
  const groups = [
    projects.filter((path) => path !== "./tsconfig.test.json"),
    projects.filter((path) => path === "./tsconfig.test.json"),
  ];
  for (const group of groups) {
    const exitCode = await run([...group, ...args]);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = await typecheck(
    process.argv.slice(2),
    (args) =>
      Bun.spawn(["tsc", "-b", ...args], {
        cwd: resolve(import.meta.dirname, ".."),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).exited,
  );
}
