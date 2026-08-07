import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let root: string;
const repoRoot = resolve(import.meta.dirname, "../../..");
const passMessage = "Core layering check passed.";

type GateResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runBun = async (args: readonly string[]): Promise<GateResult> => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const write = async (path: string, contents: string): Promise<void> => {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "core-layering-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("core layering boundary", () => {
  test("rejects every app, services, and operations import into the CLI shell", async () => {
    // Given
    await Promise.all([
      write("core/src/app/new-edge.ts", 'import "../cli/app-resolution.ts";\n'),
      write("core/src/operations/start.ts", 'import { publishTaskStart } from "../cli/progress.ts";\n'),
      write("core/src/app/normalized-edge.ts", 'import "./../cli/commands/info.ts";\n'),
      write(
        "core/src/app/package-imports.ts",
        [
          'import { runCli } from "@lando/core/cli";',
          'import type { AppOperation } from "@lando/core/cli/operations";',
          'export { runCli as cli } from "@lando/core/cli";',
          'void import("@lando/core/cli/operations");',
          "void runCli;",
          "export type Operation = AppOperation;",
          "",
        ].join("\n"),
      ),
      write(
        "core/src/app/package-import-guards.ts",
        [
          'import "@lando/core/services";',
          'import "@lando/core/client";',
          'import "@lando/sdk/probe";',
          "",
        ].join("\n"),
      ),
      write("core/src/services/new-edge.ts", 'void import("../cli/commands/info.ts");\n'),
      write("core/src/services/nested/new-edge.ts", 'import "../../cli/commands/info.ts";\n'),
      write(
        "core/src/app/operations.ts",
        'import { startApp } from "../cli/commands/start.ts";\nvoid startApp;\n',
      ),
      write(
        "core/src/app/handle.ts",
        [
          'import type { LogsAppLine } from "../cli/commands/logs.ts";',
          'import { logsApp } from "../cli/commands/logs.ts";',
          "export type Line = LogsAppLine;",
          "void logsApp;",
          "",
        ].join("\n"),
      ),
    ]);

    // When
    const result = await runBun([
      join(repoRoot, "scripts/check-boundaries.ts"),
      "core-layering",
      `--root=${root}`,
    ]);

    // Then
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr.trimEnd().split("\n").slice(1)).toEqual([
      'core/src/app/handle.ts:1: imports CLI internals via "../cli/commands/logs.ts"',
      'core/src/app/handle.ts:2: imports CLI internals via "../cli/commands/logs.ts"',
      'core/src/app/new-edge.ts:1: imports CLI internals via "../cli/app-resolution.ts"',
      'core/src/app/normalized-edge.ts:1: imports CLI internals via "./../cli/commands/info.ts"',
      'core/src/app/operations.ts:1: imports CLI internals via "../cli/commands/start.ts"',
      'core/src/app/package-imports.ts:1: imports CLI internals via "@lando/core/cli"',
      'core/src/app/package-imports.ts:2: imports CLI internals via "@lando/core/cli/operations"',
      'core/src/app/package-imports.ts:3: imports CLI internals via "@lando/core/cli"',
      'core/src/app/package-imports.ts:4: imports CLI internals via "@lando/core/cli/operations"',
      'core/src/operations/start.ts:1: imports CLI internals via "../cli/progress.ts"',
      'core/src/services/nested/new-edge.ts:1: imports CLI internals via "../../cli/commands/info.ts"',
      'core/src/services/new-edge.ts:1: imports CLI internals via "../cli/commands/info.ts"',
    ]);
    expect(result.stderr).not.toContain("core/src/app/package-import-guards.ts");
    expect(result.stderr).not.toContain('"@lando/core/services"');
    expect(result.stderr).not.toContain('"@lando/core/client"');
    expect(result.stderr).not.toContain('"@lando/sdk/probe"');
  });

  test("runs through the root package gate", async () => {
    // Given
    const args = ["run", "check:core-layering-boundary"] as const;

    // When
    const result = await runBun(args);

    // Then
    expect(result).toMatchObject({ exitCode: 0, stdout: `${passMessage}\n` });
  });
});
