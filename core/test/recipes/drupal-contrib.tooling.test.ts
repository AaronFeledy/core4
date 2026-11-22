import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { runCli } from "../../src/cli/index.ts";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";

test("contrib start syncs the site and tooling delivers argv from the right directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-contrib-tooling-"));
  try {
    const scenario = makeScenarioProvider();
    const commands: Array<{ readonly command: readonly string[]; readonly cwd: string | undefined }> = [];
    const providerRegistry = Layer.effect(
      RuntimeProviderRegistry,
      Effect.map(RuntimeProviderRegistry, (registry) =>
        RuntimeProviderRegistry.of({
          ...registry,
          select: (target) =>
            Effect.map(registry.select(target), (provider) => ({
              ...provider,
              execStream: (_target, spec) => {
                commands.push({ command: spec.command, cwd: spec.cwd });
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
      "--answer=drupal=>=10 <11 || ^11",
    );
    await invoke("start");
    // post-start runs the sync task with the constraint as one argument.
    expect(commands).toContainEqual({
      command: ["lando-drupal-contrib-sync", "module", "my_module", ">=10 <11 || ^11"],
      cwd: "/app",
    });
    commands.length = 0;

    await invoke("drupal-contrib-sync");
    await invoke("phpunit", "--filter", "ExampleUnitTest", "tests/src/Unit");
    await invoke("phpcs", "--version");

    const extension = "/app/web/modules/custom/my_module";
    expect(commands).toEqual([
      { command: ["lando-drupal-contrib-sync", "module", "my_module", ">=10 <11 || ^11"], cwd: "/app" },
      {
        command: [
          "/app/vendor/bin/phpunit",
          "-c",
          "/app/web/core",
          "--filter",
          "ExampleUnitTest",
          "tests/src/Unit",
        ],
        cwd: extension,
      },
      {
        command: [
          "sh",
          "-c",
          expect.stringMatching(/^exec \/app\/vendor\/bin\/phpcs .*"\$@"$/m),
          "lando-tooling",
          "--version",
        ],
        cwd: extension,
      },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
