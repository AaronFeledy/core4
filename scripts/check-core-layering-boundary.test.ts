import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runRuleSet } from "./boundary/engine.ts";
import { coreLayeringRule } from "./boundary/rules/core-layering.ts";

let root: string;

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
  test("rejects new app and services imports into CLI while allowing burn-down edges", async () => {
    // Given
    await Promise.all([
      write("core/src/app/new-edge.ts", 'import "../cli/app-resolution.ts";\n'),
      write("core/src/app/normalized-edge.ts", 'import "./../cli/commands/info.ts";\n'),
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
    const results = await runRuleSet([coreLayeringRule], root);

    // Then
    expect(results.get("core-layering")?.violations).toEqual([
      {
        file: "core/src/app/handle.ts",
        line: 2,
        detail: 'imports CLI internals via "../cli/commands/logs.ts"',
      },
      {
        file: "core/src/app/new-edge.ts",
        line: 1,
        detail: 'imports CLI internals via "../cli/app-resolution.ts"',
      },
      {
        file: "core/src/app/normalized-edge.ts",
        line: 1,
        detail: 'imports CLI internals via "./../cli/commands/info.ts"',
      },
      {
        file: "core/src/services/nested/new-edge.ts",
        line: 1,
        detail: 'imports CLI internals via "../../cli/commands/info.ts"',
      },
      {
        file: "core/src/services/new-edge.ts",
        line: 1,
        detail: 'imports CLI internals via "../cli/commands/info.ts"',
      },
    ]);
  });
});
