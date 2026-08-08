import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";

import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import { resolveLandofileIncludes } from "@lando/landofile/includes";
import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";

const resolve = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(resolveLandofileIncludes({ landofile, appRoot, cacheRoot: join(appRoot, ".cache") }));

describe("tooling include precedence", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-precedence-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("a fragment-local task wins over a nested internal task with the same id", async () => {
    // Given a nested internal task shadowed by a non-internal task in its parent fragment
    await writeFile(join(appRoot, "child.yml"), "tooling:\n  build:\n    cmd: nested\n", "utf8");
    await writeFile(
      join(appRoot, "parent.yml"),
      [
        "toolingIncludes:",
        "  child:",
        "    file: ./child.yml",
        "    flatten: true",
        "    internal: true",
        "tooling:",
        "  build:",
        "    cmd: local",
        "",
      ].join("\n"),
      "utf8",
    );

    // When the parent fragment is included
    const resolved = await resolve({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then the local task wins and does not retain the nested task's internal provenance
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("local");
    expect(getInternalToolingTasks(resolved)).not.toContain("docs:build");
  });

  test("an outer internal include keeps a fragment-local winner internal", async () => {
    // Given the same local winner under an outer include marked internal
    await writeFile(join(appRoot, "child.yml"), "tooling:\n  build:\n    cmd: nested\n", "utf8");
    await writeFile(
      join(appRoot, "parent.yml"),
      [
        "toolingIncludes:",
        "  child:",
        "    file: ./child.yml",
        "    flatten: true",
        "tooling:",
        "  build:",
        "    cmd: local",
        "",
      ].join("\n"),
      "utf8",
    );

    // When the outer include is resolved with internal true
    const resolved = await resolve(
      { toolingIncludes: { docs: { file: "./parent.yml", internal: true } } },
      appRoot,
    );

    // Then outer provenance applies to the local winner
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("local");
    expect(getInternalToolingTasks(resolved)).toContain("docs:build");
  });

  test("a root-authored winner is visible to the command compiler", async () => {
    // Given an internal flattened include shadowed by a root-authored task
    await writeFile(join(appRoot, "tasks.yml"), "tooling:\n  build:\n    cmd: nested\n", "utf8");

    // When the Landofile resolves and compiles its tooling commands
    const resolved = await resolve(
      {
        toolingIncludes: { docs: { file: "./tasks.yml", flatten: true, internal: true } },
        tooling: { build: { cmd: "root" } },
      },
      appRoot,
    );
    const commands = compileToolingCommands(resolved);

    // Then the root winner is not hidden by stale include provenance
    expect(resolved.tooling?.build?.cmd).toBe("root");
    expect(commands.find((command) => command.id === "app:build")?.hidden).toBe(false);
  });
});
