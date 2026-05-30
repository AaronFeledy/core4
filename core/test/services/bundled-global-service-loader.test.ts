import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";

import { bundledFirstGlobalServiceLoader } from "../../src/services/bundled-global-service-loader.ts";
import type { PendingGlobalServiceContribution } from "../../src/services/global-services.ts";

const entry = (plugin: string, id: string, module?: string): PendingGlobalServiceContribution => ({
  plugin,
  contribution: module === undefined ? { id } : { id, module },
});

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("bundled-first global service loader", () => {
  test("resolves a bundled plugin's global service from the static map (no dynamic import)", async () => {
    const config = await Effect.runPromise(
      bundledFirstGlobalServiceLoader.load(
        entry("@lando/proxy-traefik", "traefik", "./src/global-services/traefik.ts"),
      ),
    );
    expect(config.type).toBe("compose");
    expect(config.image).toBe("traefik:v3.3");
  });

  test("fails with GlobalAppError when a bundled plugin lacks the requested static entry", async () => {
    const exit = await Effect.runPromiseExit(
      // @lando/service-lando is bundled but contributes no globalServices map.
      bundledFirstGlobalServiceLoader.load(entry("@lando/service-lando", "traefik", "./x.ts")),
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(GlobalAppError);
    if (!(failure instanceof GlobalAppError)) throw new Error("expected GlobalAppError");
    expect(failure.message).toContain("@lando/service-lando");
    expect(failure.message).toContain("traefik");
  });

  test("falls back to dynamic import for a non-bundled plugin", async () => {
    const moduleRoot = await mkdtemp(join(process.cwd(), ".lando-bundled-loader-"));
    try {
      const modulePath = join(moduleRoot, "external-global-service.mjs");
      await writeFile(
        modulePath,
        'import { Effect } from "effect";\nexport default Effect.succeed({ api: 4, type: "lando" });\n',
      );
      const config = await Effect.runPromise(
        bundledFirstGlobalServiceLoader.load(entry("@lando/external-plugin", "ext", modulePath)),
      );
      expect(config.type).toBe("lando");
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });
});
