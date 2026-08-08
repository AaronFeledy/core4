import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";

import { appPlanCachePath } from "@lando/engine/cache/paths";
import { getLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import {
  IMPORTED_PEM,
  PEM,
  discover,
  planDiscovered,
  planDiscoveredEffect,
  withApp,
} from "./landofile-load-expression-support.ts";

test("plans discovered load and import CA expressions through AppPlanner", async () => {
  await withApp(async (appRoot) => {
    // Given
    const cacheRoot = join(appRoot, ".cache");
    await writeFile(join(appRoot, "load.pem"), PEM);
    await writeFile(join(appRoot, "import.pem"), IMPORTED_PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    type: node:22",
        "    security:",
        "      ca:",
        "        - \"{{ load('./load.pem') }}\"",
        "        - \"{{ import('./import.pem') }}\"",
        "",
      ].join("\n"),
    );

    // When
    const plan = await planDiscovered({ appRoot, cacheRoot });

    // Then
    const service = plan.services[ServiceName.make("web")];
    expect(service?.mounts.filter((mount) => String(mount.target).includes("lando-")).length).toBe(2);
    expect(service?.extensions["@lando/core/service-features"]).toBeDefined();
  });
});

test("reports remediation for invalid imported PEM through discovery and planning", async () => {
  await withApp(async (appRoot) => {
    // Given
    const cacheRoot = join(appRoot, ".cache");
    await writeFile(join(appRoot, "invalid.pem"), "not a certificate\n");
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    type: node:22",
        "    security:",
        "      ca:",
        "        - \"{{ import('./invalid.pem') }}\"",
        "",
      ].join("\n"),
    );

    // When
    const exit = await Effect.runPromiseExit(planDiscoveredEffect({ appRoot, cacheRoot }));

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected invalid imported PEM failure");
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(String(failure)).toContain("must resolve to a valid PEM certificate");
    expect(String(failure)).toContain("complete CERTIFICATE block");
  });
});

test("invalidates the app-plan cache on referenced bytes but not mtime-only drift", async () => {
  await withApp(async (appRoot) => {
    // Given
    const cacheRoot = join(appRoot, ".cache");
    const pemPath = join(appRoot, "corp.pem");
    const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    try {
      await writeFile(pemPath, PEM);
      await writeFile(
        join(appRoot, ".lando.yml"),
        [
          "name: trust-app",
          "services:",
          "  web:",
          "    type: node:22",
          "    security:",
          "      ca:",
          "        - \"{{ load('./corp.pem') }}\"",
          "",
        ].join("\n"),
      );
      await planDiscovered({ appRoot, cacheRoot });
      const cachePath = appPlanCachePath(cacheRoot, "trust-app", appRoot);
      const first = await readFile(cachePath);
      const current = await stat(pemPath);

      // When
      await utimes(pemPath, current.atime, new Date(current.mtimeMs + 5_000));
      await planDiscovered({ appRoot, cacheRoot });
      const touched = await readFile(cachePath);

      // Then
      expect(touched).toEqual(first);

      // When
      await writeFile(pemPath, IMPORTED_PEM);
      await planDiscovered({ appRoot, cacheRoot });
      const changed = await readFile(cachePath);

      // Then
      expect(changed).not.toEqual(first);
    } finally {
      if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    }
  });
});

test("invalidates the app-plan cache when an included fragment reference changes", async () => {
  await withApp(async (appRoot) => {
    // Given
    const cacheRoot = join(appRoot, ".cache");
    const pemPath = join(appRoot, "fragments", "corp.pem");
    const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    try {
      await mkdir(join(appRoot, "fragments"));
      await writeFile(pemPath, PEM);
      await writeFile(
        join(appRoot, "fragments", "service.yml"),
        [
          "services:",
          "  web:",
          "    type: node:22",
          "    security:",
          "      ca:",
          "        - \"{{ load('./corp.pem') }}\"",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(appRoot, ".lando.yml"),
        ["name: trust-app", "includes:", "  - ./fragments/service.yml", ""].join("\n"),
      );
      const landofile = await discover();

      // Then
      expect(getLandofileReferencedFiles(landofile)).toContainEqual(
        expect.objectContaining({ absolutePath: pemPath }),
      );

      await planDiscovered({ appRoot, cacheRoot });
      const cachePath = appPlanCachePath(cacheRoot, "trust-app", appRoot);
      const first = await readFile(cachePath);

      // When
      await writeFile(pemPath, IMPORTED_PEM);
      await planDiscovered({ appRoot, cacheRoot });
      const changed = await readFile(cachePath);

      // Then
      expect(changed).not.toEqual(first);
    } finally {
      if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    }
  });
});
