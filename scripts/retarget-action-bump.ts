#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { CODEGEN_CATALOG, resolveCodegenCommand } from "./codegen-catalog.ts";
import { applyPinMoves, parsePinDiff } from "./retarget-action-pins.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOTS = ["scripts", "core/test"] as const;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const walkSources = async (
  root: string,
): Promise<readonly { readonly path: string; readonly text: string }[]> => {
  const visit = async (
    directory: string,
  ): Promise<readonly { readonly path: string; readonly text: string }[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === "node_modules" || entry.name === "dist") return [];
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return visit(path);
        if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
        return [{ path: relative(root, path), text: await Bun.file(path).text() }];
      }),
    );
    return nested.flat();
  };
  const groups = await Promise.all(SOURCE_ROOTS.map((directory) => visit(join(root, directory))));
  return groups.flat();
};

const gitText = async (args: readonly string[], root: string): Promise<string> => {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed with ${exitCode}`);
  return stdout;
};

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};

const retarget = async (root: string, base: string, head: string): Promise<void> => {
  if (!SHA_PATTERN.test(base) || !SHA_PATTERN.test(head))
    throw new Error("base and head must be 40-character commit shas");
  const parsed = parsePinDiff(await gitText(["diff", base, head, "--", ".github/workflows"], root));
  if (parsed.kind === "rejected") throw new Error(parsed.reason);
  if (parsed.moves.length === 0) return;

  const applied = applyPinMoves(await walkSources(root), parsed.moves);
  if (applied.kind === "unresolved")
    throw new Error(`no generator or test contains ${applied.action}@${applied.oldRef}`);
  await Promise.all(applied.files.map((file) => Bun.write(join(root, file.path), file.text)));

  for (const entry of CODEGEN_CATALOG) {
    if (entry.ownership !== "committed-workflow") continue;
    const command = resolveCodegenCommand(entry);
    const child = Bun.spawn({ cmd: [...command.cmd], cwd: command.cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `${entry.id} failed with ${exitCode}`);
  }

  const mismatches: string[] = [];
  for (const path of parsed.workflowPaths) {
    const expected = await gitText(["show", `${head}:${path}`], root);
    if ((await Bun.file(join(root, path)).text()) !== expected) mismatches.push(path);
  }
  if (mismatches.length > 0)
    throw new Error(`regenerated workflows do not match ${head}: ${mismatches.join(", ")}`);
};

if (import.meta.main) {
  const base = flagValue(process.argv, "--base");
  const head = flagValue(process.argv, "--head");
  if (base === undefined || head === undefined) {
    process.stderr.write("usage: retarget-action-bump.ts --base <sha> --head <sha>\n");
    process.exitCode = 1;
  } else {
    try {
      await retarget(REPO_ROOT, base, head);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
