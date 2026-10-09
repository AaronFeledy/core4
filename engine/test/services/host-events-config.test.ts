import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { Effect, Exit } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { isExcludedFromUserAppDefaults } from "../../src/planner/app-defaults.ts";
import { layer, loadGlobalConfigSync, takeGlobalConfigTypoWarnings } from "../../src/services/config.ts";

const previous = new Map<string, string>();

beforeEach(async () => {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LANDO_") && value !== undefined) {
      previous.set(key, value);
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("LANDO_")) delete process.env[key];
  for (const [key, value] of previous) process.env[key] = value;
  previous.clear();
});

const withConfRoot = async (write: (dir: string) => Promise<void>, run: () => void | Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-host-events-config-"));
  process.env.LANDO_USER_CONF_ROOT = dir;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
  process.env.LANDO_USER_CACHE_ROOT = join(dir, "cache");
  try {
    await write(dir);
    await run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("config.yml hostEvents load", () => {
  test("rejects a container step in pre-start and names config.yml hostEvents.<event>[i]", async () => {
    await withConfRoot(
      (dir) => writeFile(join(dir, "config.yml"), "hostEvents:\n  pre-start:\n    - echo container\n"),
      () => {
        expect(() => loadGlobalConfigSync()).toThrow(/config\.yml hostEvents\.pre-start\[0\]/);
      },
    );
  });

  test("rejects unknown hostEvents fields at load", async () => {
    await withConfRoot(
      (dir) =>
        writeFile(
          join(dir, "config.yml"),
          'hostEvents:\n  pre-start:\n    - cmd: echo host\n      service: ":host"\n      task: nope\n',
        ),
      () => {
        expect(() => loadGlobalConfigSync()).toThrow(/hostEvents|task|Expected/);
      },
    );
  });

  test("warns about a misspelled top-level key without failing load", async () => {
    await withConfRoot(
      (dir) =>
        writeFile(
          join(dir, "config.yml"),
          'hostEvent:\n  pre-start:\n    - cmd: echo host\n      service: ":host"\n',
        ),
      () => {
        const loaded = loadGlobalConfigSync();
        expect(loaded.hostEvents).toBeUndefined();
        const warnings = takeGlobalConfigTypoWarnings();
        expect(warnings.some((warning) => warning.includes('Unknown config.yml key "hostEvent"'))).toBe(true);
        expect(warnings.some((warning) => warning.includes("hostEvents"))).toBe(true);
      },
    );
  });

  test("round-trips hostEvents through emitLandofileYaml and yaml-min", async () => {
    const emitted = emitLandofileYaml({
      hostEvents: {
        "pre-start": [{ cmd: 'echo "a #b"', service: ":host" }],
      },
    });
    const parsed = parseMinimalYaml(emitted) as {
      readonly hostEvents: {
        readonly "pre-start": ReadonlyArray<{ readonly cmd: string; readonly service: string }>;
      };
    };
    expect(parsed.hostEvents["pre-start"][0]?.cmd).toContain("#");
    expect(parsed.hostEvents["pre-start"][0]?.service).toBe(":host");
  });

  test("excludes the global app and scratch apps from hostEvents", () => {
    const paths = { globalAppRoot: "/home/user/.lando/global", scratchDir: "/tmp/lando-scratch" };
    expect(isExcludedFromUserAppDefaults("global", "/apps/site", paths)).toBe(true);
    expect(isExcludedFromUserAppDefaults("site", "/home/user/.lando/global", paths)).toBe(true);
    expect(isExcludedFromUserAppDefaults("scratch", "/tmp/lando-scratch/work", paths)).toBe(true);
    expect(isExcludedFromUserAppDefaults("site", "/apps/site", paths)).toBe(false);
  });
});

test("config load is fail-loud for hostEvents and still returns Effect failures", async () => {
  await withConfRoot(
    (dir) => writeFile(join(dir, "config.yml"), "hostEvents:\n  post-destroy:\n    - echo gone\n"),
    async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const service = yield* ConfigService;
          return yield* service.load;
        }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    },
  );
});
