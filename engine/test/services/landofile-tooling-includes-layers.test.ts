import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { compileToolingCommands } from "../../src/cache/command-compiler";
import { loadLandofileLayers } from "../../src/services/landofile-live";

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

test("an authored internal fragment hides its compiled commands", async () => {
  // Given a Landofile whose only tooling include is marked internal
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-internal-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "tasks.yml"), "tooling:\n  build:\n    cmd: make\n", "utf8");
    await writeFile(
      canonicalPath,
      ["name: hidden", "toolingIncludes:", "  docs:", "    file: ./tasks.yml", "    internal: true", ""].join(
        "\n",
      ),
      "utf8",
    );

    // When the Landofile is loaded and command metadata is compiled
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));
    const commands = compileToolingCommands(resolved);

    // Then the contributed command exists but is hidden from listings
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("make");
    expect(commands.find((command) => command.id === "app:docs:build")?.hidden).toBe(true);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("composes canonical tooling declarations from every Landofile layer", async () => {
  // Given each layer declaring a distinct canonical tooling include
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-layer-canonical-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "a.tasks.yml"), "tooling:\n  abuild:\n    cmd: a\n", "utf8");
    await writeFile(join(appRoot, "b.tasks.yml"), "tooling:\n  bbuild:\n    cmd: b\n", "utf8");
    await writeFile(
      join(appRoot, ".lando.base.yml"),
      ["includes:", "  - source: ./a.tasks.yml", "    kind: tooling", "    namespace: a", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      canonicalPath,
      [
        "name: layered",
        "includes:",
        "  - source: ./b.tasks.yml",
        "    kind: tooling",
        "    namespace: b",
        "",
      ].join("\n"),
      "utf8",
    );

    // When the complete Landofile is loaded
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));

    // Then no layer's declaration is replaced by a higher layer's includes array
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual(["a:abuild", "b:bbuild"]);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("keeps sibling canonical declarations sharing a namespace in one layer", async () => {
  // Given one layer pointing a single namespace at two fragments
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-layer-siblings-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "a.yml"), "tooling:\n  atask:\n    cmd: a\n", "utf8");
    await writeFile(join(appRoot, "b.yml"), "tooling:\n  btask:\n    cmd: b\n", "utf8");
    await writeFile(
      canonicalPath,
      [
        "name: siblings",
        "includes:",
        "  - source: ./a.yml",
        "    kind: tooling",
        "    namespace: shared",
        "  - source: ./b.yml",
        "    kind: tooling",
        "    namespace: shared",
        "",
      ].join("\n"),
      "utf8",
    );

    // When the complete Landofile is loaded through the layer path
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));

    // Then the layer path agrees with direct include resolution and drops neither fragment
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual(["shared:atask", "shared:btask"]);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("a higher layer overrides a canonical tooling declaration sharing its namespace", async () => {
  // Given a base-layer canonical declaration the canonical layer redirects by namespace
  const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-layer-canonical-override-"));
  const canonicalPath = join(appRoot, ".lando.yml");
  try {
    await writeFile(join(appRoot, "canonical-tasks.yml"), "tooling:\n  build:\n    cmd: canonical\n", "utf8");
    await writeFile(
      join(appRoot, ".lando.base.yml"),
      [
        "includes:",
        "  - source: ./missing-base-tasks.yml",
        "    kind: tooling",
        "    namespace: docs",
        "    internal: true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      canonicalPath,
      [
        "name: layered",
        "includes:",
        "  - source: ./canonical-tasks.yml",
        "    kind: tooling",
        "    namespace: docs",
        "",
      ].join("\n"),
      "utf8",
    );

    // When the complete Landofile is loaded and command metadata is compiled
    const resolved = await Effect.runPromise(loadLandofileLayers(appRoot, canonicalPath));
    const commands = compileToolingCommands(resolved);

    // Then the shadowed source is never read and the base layer's flags still apply
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("canonical");
    expect(commands.find((command) => command.id === "app:docs:build")?.hidden).toBe(true);
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
