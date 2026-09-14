import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LandoRuntimeOptions, makeLandoRuntime } from "@lando/core";
import { AbsolutePath, ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { installEngineComposition } from "@lando/engine/composition";
import { Effect } from "effect";
import { appConfigValidate } from "../../src/cli/commands/app-config.ts";

for (const bootstrap of ["commands", "app"] as const) {
  test(`${bootstrap} embedding loads profiles from runtime roots instead of process roots`, async () => {
    // Given: conflicting host configuration must not supply this app's profile.
    const root = await mkdtemp(join(tmpdir(), "lando-embedded-profile-"));
    const cwd = process.cwd();
    const previousConf = process.env.LANDO_USER_CONF_ROOT;
    const previousCache = process.env.LANDO_USER_CACHE_ROOT;
    const composition = globalThis.__landoEngineCompositionInputs;
    if (composition === undefined) throw new TypeError("Core composition is required");
    const conf = join(root, "runtime-conf");
    const app = join(root, "app");
    try {
      await mkdir(join(conf, "includes"), { recursive: true });
      await mkdir(join(root, "host-conf", "includes"), { recursive: true });
      await mkdir(app);
      await writeFile(join(app, ".lando.yml"), "name: embedded-profile\nincludes: [user:profile.yml]\n");
      await writeFile(
        join(conf, "includes", "profile.yml"),
        "services:\n  web:\n    image: alpine:3.21\n    environment:\n      ORIGIN: embedded\n",
      );
      await writeFile(join(root, "host-conf", "includes", "profile.yml"), "name: forbidden-host-profile\n");
      process.env.LANDO_USER_CONF_ROOT = join(root, "host-conf");
      process.env.LANDO_USER_CACHE_ROOT = join(root, "host-cache");
      installEngineComposition({
        ...composition,
        landofileRuntimeInputs: {
          ...composition.landofileRuntimeInputs,
          ports: {
            ...composition.landofileRuntimeInputs.ports,
            resolveUserCacheRoot: () => {
              throw new TypeError("Process-global cache root must not be read");
            },
          },
        },
      });
      process.chdir(app);
      const options = {
        plugins: { policy: "bundled-only" as const },
        config: {
          userConfRoot: AbsolutePath.make(conf),
          userCacheRoot: AbsolutePath.make(join(root, "runtime-cache")),
          userDataRoot: AbsolutePath.make(join(root, "runtime-data")),
          systemPluginRoot: AbsolutePath.make(join(root, "system")),
        },
      } satisfies LandoRuntimeOptions;
      const discover = Effect.gen(function* () {
        const landofile = yield* (yield* LandofileService).discover;
        const validation = yield* appConfigValidate({ cwd: app });
        return { landofile, validation };
      });
      const commandsOptions: LandoRuntimeOptions & { readonly bootstrap: "commands" } = {
        ...options,
        bootstrap: "commands",
      };
      const appOptions: LandoRuntimeOptions & { readonly bootstrap: "app" } = {
        ...options,
        bootstrap: "app",
      };
      const program =
        bootstrap === "commands"
          ? discover.pipe(Effect.provide(makeLandoRuntime(commandsOptions)))
          : discover.pipe(Effect.provide(makeLandoRuntime(appOptions)));

      // When: the public embedding factory builds the real discovery service.
      const { landofile, validation } = await Effect.runPromise(Effect.scoped(program));

      // Then: the conflicting process profile was never consumed.
      expect(landofile.services?.[ServiceName.make("web")]?.environment?.ORIGIN).toBe("embedded");
      expect(validation.valid).toBe(true);
    } finally {
      installEngineComposition(composition);
      process.chdir(cwd);
      if (previousConf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConf;
      if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCache;
      await rm(root, { recursive: true, force: true });
    }
  });
}
