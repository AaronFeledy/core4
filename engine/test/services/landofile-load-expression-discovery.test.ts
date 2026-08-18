import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { LandofileLoadOutsideRootError, NotImplementedError } from "@lando/sdk/errors";
import { GlobalConfig, ServiceName } from "@lando/sdk/schema";
import { ConfigService, LandofileService, Logger } from "@lando/sdk/services";

import { LandofileServiceLive } from "../../src/services/landofile-live";
import { PEM, discover, discoverFailure, withApp } from "./landofile-load-expression-support.ts";

test("discovers load and import CA expressions", async () => {
  await withApp(async (appRoot) => {
    // Given
    await mkdir(join(appRoot, "certs"));
    await writeFile(join(appRoot, "certs", "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    type: node:22",
        "    security:",
        "      ca:",
        "        - \"{{ load('./certs/corp.pem') }}\"",
        "        - \"{{ import('./certs/corp.pem') }}\"",
        "",
      ].join("\n"),
    );

    // When
    const landofile = await discover();

    // Then
    const ca = landofile.services?.[ServiceName.make("web")]?.security?.ca;
    expect(ca?.[0]).toBe(PEM);
    expect(ca?.[1]).toMatchObject({
      _tag: "ImportRef",
      value: PEM,
      path: "./certs/corp.pem",
      basename: "corp.pem",
      checksum: createHash("sha256").update(PEM).digest("hex"),
      layer: "canonical",
    });
  });
});

test("keeps unrelated Landofile expressions deferred", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, ".lando.yml"), 'name: "{{ env.APP_NAME }}"\n');

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(NotImplementedError);
  });
});

test("keeps context paths deferred when combined with load", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca:",
        "        - \"{{ default(load('./corp.pem'), env.CA) }}\"",
        "",
      ].join("\n"),
    );

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(NotImplementedError);
  });
});

test("resolves import relative to an include fragment and preserves its layer", async () => {
  await withApp(async (appRoot) => {
    // Given
    await mkdir(join(appRoot, "fragments", "certs"), { recursive: true });
    await writeFile(join(appRoot, "fragments", "certs", "corp.pem"), PEM);
    await writeFile(
      join(appRoot, "fragments", "service.yml"),
      [
        "services:",
        "  web:",
        "    type: node:22",
        "    security:",
        "      ca:",
        "        - \"{{ import('./certs/corp.pem') }}\"",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: trust-app", "includes:", "  - ./fragments/service.yml", ""].join("\n"),
    );

    // When
    const landofile = await discover();

    // Then
    expect(landofile.services?.[ServiceName.make("web")]?.security?.ca?.[0]).toMatchObject({
      _tag: "ImportRef",
      path: "./certs/corp.pem",
      basename: "corp.pem",
      layer: "canonical",
    });
  });
});

test("rejects a lexical outside-root load through discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-load-outside-"));
  const appRoot = join(root, "app");
  const cwd = process.cwd();
  try {
    // Given
    await mkdir(appRoot);
    await writeFile(join(root, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca:",
        "        - \"{{ load('../corp.pem') }}\"",
        "",
      ].join("\n"),
    );
    process.chdir(appRoot);

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(LandofileLoadOutsideRootError);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlink outside-root load through discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-load-symlink-outside-"));
  const appRoot = join(root, "app");
  const cwd = process.cwd();
  try {
    // Given
    await mkdir(appRoot);
    await writeFile(join(root, "corp.pem"), PEM);
    await symlink(join(root, "corp.pem"), join(appRoot, "corp.pem"));
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca:",
        "        - \"{{ load('./corp.pem') }}\"",
        "",
      ].join("\n"),
    );
    process.chdir(appRoot);

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(LandofileLoadOutsideRootError);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("allows and logs an opted-in outside-root load", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-load-outside-opt-in-"));
  const appRoot = join(root, "app");
  const cwd = process.cwd();
  const messages: string[] = [];
  try {
    // Given
    await mkdir(appRoot);
    await writeFile(join(root, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca:",
        "        - \"{{ load('../corp.pem') }}\"",
        "",
      ].join("\n"),
    );
    process.chdir(appRoot);
    const config = Schema.decodeUnknownSync(GlobalConfig)({ allowLoadOutsideRoot: true });
    const layer = Layer.mergeAll(
      LandofileServiceLive,
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
      }),
      Layer.succeed(Logger, {
        debug: () => Effect.void,
        info: (message) => Effect.sync(() => messages.push(message)),
        warn: () => Effect.void,
        error: () => Effect.void,
      }),
    );

    // When
    const landofile = await Effect.runPromise(
      Effect.flatMap(LandofileService, (service) => service.discover).pipe(Effect.provide(layer)),
    );

    // Then
    expect(landofile.services?.[ServiceName.make("web")]?.security?.ca).toEqual([PEM]);
    expect(messages).toEqual(["Landofile load used outside-root policy override"]);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("logs an opted-in outside-root load from an include fragment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-load-include-outside-opt-in-"));
  const appRoot = join(root, "app");
  const cwd = process.cwd();
  const messages: string[] = [];
  try {
    // Given
    await mkdir(join(appRoot, "fragments"), { recursive: true });
    await writeFile(join(root, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, "fragments", "service.yml"),
      [
        "services:",
        "  web:",
        "    type: node:22",
        "    security:",
        "      ca:",
        "        - \"{{ load('../../corp.pem') }}\"",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: trust-app", "includes:", "  - ./fragments/service.yml", ""].join("\n"),
    );
    process.chdir(appRoot);
    const config = Schema.decodeUnknownSync(GlobalConfig)({ allowLoadOutsideRoot: true });
    const layer = Layer.mergeAll(
      LandofileServiceLive,
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
      }),
      Layer.succeed(Logger, {
        debug: () => Effect.void,
        info: (message) => Effect.sync(() => messages.push(message)),
        warn: () => Effect.void,
        error: () => Effect.void,
      }),
    );

    // When
    const landofile = await Effect.runPromise(
      Effect.flatMap(LandofileService, (service) => service.discover).pipe(Effect.provide(layer)),
    );

    // Then
    expect(landofile.services?.[ServiceName.make("web")]?.security?.ca).toEqual([PEM]);
    expect(messages).toEqual(["Landofile load used outside-root policy override"]);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});
