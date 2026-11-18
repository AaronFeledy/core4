import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { runCli } from "../../src/cli/index.ts";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";

test("contrib tooling delivers the core constraint and PHPUnit flags as argv", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-contrib-tooling-"));
  try {
    const scenario = makeScenarioProvider();
    const commands: Array<readonly string[]> = [];
    const providerRegistry = Layer.effect(
      RuntimeProviderRegistry,
      Effect.map(RuntimeProviderRegistry, (registry) =>
        RuntimeProviderRegistry.of({
          ...registry,
          select: (target) =>
            Effect.map(registry.select(target), (provider) => ({
              ...provider,
              execStream: (_target, spec) => {
                commands.push(spec.command);
                return Stream.make({ exitCode: 0 });
              },
            })),
        }),
      ),
    ).pipe(Layer.provide(scenario.layer));
    const env = {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(cwd, "data"),
      LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
      LANDO_USER_CONF_ROOT: join(cwd, "config"),
    };
    const invoke = async (...argv: readonly string[]) => {
      const io = createBufferedRendererIO({ stdin: "" });
      let exitCode = 0;
      await runCli({
        argv,
        rootUrl: new URL("../../bin/lando.ts", import.meta.url).href,
        context: {
          cwd,
          env,
          io,
          providerRegistry,
          serviceLayers: [scenario.hostServices],
          setExitCode: (code) => {
            exitCode = code;
          },
        },
      });
      expect(exitCode, io.stderr()).toBe(0);
      return io.stdout();
    };

    await invoke(
      "init",
      ".",
      "--recipe=drupal-contrib",
      "--name=contrib-tooling",
      "--yes",
      "--answer=project=my_module",
    );
    await invoke("start");
    expect(await invoke("core-version", "--help")).toContain("<CONSTRAINT>");
    commands.length = 0;

    await invoke("core-version", "^10");
    await invoke("core-version", ">=10 <11 || ^11");
    await invoke("phpunit", "--filter", "ExampleUnitTest", "web/modules/custom/my_module/tests/src/Unit");
    await invoke("phpunit", "--version");

    expect(commands).toEqual([
      ["lando-drupal-contrib-core-version", "module", "my_module", "^10"],
      ["lando-drupal-contrib-core-version", "module", "my_module", ">=10 <11 || ^11"],
      [
        "vendor/bin/phpunit",
        "-c",
        "web/core",
        "--filter",
        "ExampleUnitTest",
        "web/modules/custom/my_module/tests/src/Unit",
      ],
      ["vendor/bin/phpunit", "-c", "web/core", "--version"],
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
