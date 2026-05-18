import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { CommandRegistry } from "@lando/core/services";

import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { CommandRegistryLive } from "../../src/services/command-registry.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-command-registry-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const registryLayer = Layer.provide(CommandRegistryLive, LandofileServiceLive);

const listFromLive = () =>
  Effect.runPromise(
    Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(Effect.provide(registryLayer)),
  );

const listFromBootstrap = () =>
  Effect.runPromise(
    Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
      Effect.provide(makeLandoRuntime({ bootstrap: "tooling" })),
    ),
  );

describe("CommandRegistryLive", () => {
  test("lists parsed tooling tasks as RegisteredCommand entries under the app: namespace", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  composer:",
          "    description: Run Composer in the appserver",
          "    service: appserver",
          "    cmd: composer",
          "  test:",
          "    description: Run the test suite",
          "    service: appserver",
          "    cmds:",
          "      - composer install",
          "      - phpunit",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual(["app:composer", "app:test"]);

      const composer = commands.find((c) => c.id === "app:composer");
      expect(composer?.summary).toBe("Run Composer in the appserver");
      expect(composer?.hidden).toBe(false);

      const t = commands.find((c) => c.id === "app:test");
      expect(t?.summary).toBe("Run the test suite");
    });
  });

  test("returns an empty list when no Landofile is present (router-bootstrap-omits-tooling contract)", async () => {
    await withTempCwd(async (dir) => {
      process.chdir(dir);
      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("returns an empty list when Landofile parse fails (Beta-deferred surface, no rejection at registry layer)", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "includes:", "  - ./fragment.yml", ""].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("returns an empty list when the Landofile has no `tooling:` section", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    image: node:lts", ""].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("uses `summary:` when `description:` is absent", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "tooling:", "  build:", "    summary: Build everything", "    cmd: make", ""].join(
          "\n",
        ),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const build = commands.find((c) => c.id === "app:build");
      expect(build?.summary).toBe("Build everything");
    });
  });

  test("makeLandoRuntime({ bootstrap: 'tooling' }) provides CommandRegistry populated from the Landofile", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  build:",
          "    description: Build assets",
          "    service: appserver",
          "    cmd: make",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromBootstrap();
      expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      expect(commands[0]?.summary).toBe("Build assets");
    });
  });
});
