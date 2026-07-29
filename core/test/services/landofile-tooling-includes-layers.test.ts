import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { compileToolingCommands } from "../../src/cache/command-compiler.ts";
import { loadLandofileLayers } from "../../src/landofile/service.ts";
import { getInternalToolingTasks } from "../../src/landofile/tooling-include-provenance.ts";

test("a higher Landofile layer removes internal provenance from its task winner", async () => {
  // Given a base-layer internal include shadowed by a canonical-layer task
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-layer-regression-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "tasks.yml"), "tooling:\n  build:\n    cmd: base\n", "utf8");
    await writeFile(
      join(appRoot, ".lando.base.yml"),
      [
        "toolingIncludes:",
        "  base:",
        "    file: ./tasks.yml",
        "    flatten: true",
        "    internal: true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      canonicalPath,
      ["name: layered", "tooling:", "  build:", "    cmd: canonical", ""].join("\n"),
      "utf8",
    );

    // When all Landofile layers are loaded and command metadata is compiled
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));
    const commands = compileToolingCommands(resolved);

    // Then the higher-layer winner is visible and carries no stale internal provenance
    expect(resolved.tooling?.build?.cmd).toBe("canonical");
    expect(getInternalToolingTasks(resolved)).not.toContain("build");
    expect(commands.find((command) => command.id === "app:build")?.hidden).toBe(false);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("resolves tooling includes only after Landofile layers merge", async () => {
  // Given a lower-layer tooling source replaced by a valid higher-layer source
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-layer-order-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "canonical-tasks.yml"), "tooling:\n  build:\n    cmd: canonical\n", "utf8");
    await writeFile(
      join(appRoot, ".lando.base.yml"),
      ["toolingIncludes:", "  docs:", "    file: ./missing-base-tasks.yml", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      canonicalPath,
      ["name: layered", "toolingIncludes:", "  docs:", "    file: ./canonical-tasks.yml", ""].join("\n"),
      "utf8",
    );

    // When the complete Landofile is loaded and command metadata is compiled
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));
    const commands = compileToolingCommands(resolved);

    // Then only the winning declaration is resolved
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("canonical");
    expect(commands.map((command) => command.id)).toContain("app:docs:build");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
