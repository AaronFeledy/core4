import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { GlobalAppError } from "@lando/core/errors";

import { globalInstall, renderGlobalInstallResult } from "../../src/cli/commands/meta/global-install.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-install-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-install-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

describe("global:install command operation", () => {
  test("materializes both global Landofile files with no plugin argument", async () => {
    await withTempRoots(async (dataRoot) => {
      const result = await Effect.runPromise(
        globalInstall({}).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "global" }))),
      );
      const output = renderGlobalInstallResult(result);

      expect(result.paths.root).toBe(join(dataRoot, "global"));
      expect(result.dist.path).toBe(join(dataRoot, "global", ".lando.dist.yml"));
      expect(result.dist.status).toBe("created");
      expect(result.paths.userLandofile).toBe(join(dataRoot, "global", ".lando.yml"));
      expect(result.userLandofileCreated).toBe(true);
      expect(await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8")).toContain("name: global");
      expect(await readFile(join(dataRoot, "global", ".lando.yml"), "utf8")).toContain("User overrides");
      expect(output).toContain(".lando.dist.yml");
      expect(output).toContain("created");
      expect(output).toContain("Global services: none");
    });
  });

  test("rejects plugin argument with tagged remediation", async () => {
    await withTempRoots(async () => {
      const exit = await Effect.runPromiseExit(
        globalInstall({ plugin: "@lando/proxy-traefik" }).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "global" })),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(GlobalAppError);
          if (failure.value instanceof GlobalAppError) {
            expect(failure.value.operation).toBe("install");
            expect(failure.value.remediation).toContain("lando global:install");
          }
        }
      }
    });
  });
});
