import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, type Scope } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { RuntimeProvider, RuntimeProviderRegistry, TunnelService } from "@lando/core/services";
import { TestRuntimeProvider, TestTunnelService } from "@lando/core/testing";
import { AppId, ProviderId, ServiceName, type TunnelSession, type TunnelTarget } from "@lando/sdk/schema";
import { makeLandoPaths } from "../../src/config/paths.ts";

const serviceTarget: TunnelTarget = {
  _tag: "service",
  service: ServiceName.make("web"),
  port: 80,
  protocol: "http",
};

const withTempShareApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-share-skeleton-")));
  const dataRoot = join(dir, "data");
  const cacheRoot = join(dir, "cache");
  const oldDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const oldCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  await writeFile(
    join(dir, ".lando.yml"),
    `name: share-skeleton\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    type: node:lts\n`,
  );
  const original = process.cwd();
  process.env.LANDO_USER_DATA_ROOT = dataRoot;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    if (oldDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = oldDataRoot;
    if (oldCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = oldCacheRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const providerLayers = [
  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
  }),
];

const tunnelLayer = Layer.succeed(TunnelService, TestTunnelService.service);

const isCommandSpec = (
  value: unknown,
): value is {
  readonly id: string;
  readonly bootstrap: string;
  readonly flags?: Record<string, unknown>;
  readonly resultSchema?: unknown;
  readonly topLevelAlias?: unknown;
} =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof (value as { readonly id?: unknown }).id === "string";

describe("share command skeleton", () => {
  test("registers app share command specs with result schemas and share flags", async () => {
    const modules = await Promise.all([
      import("../../src/cli/oclif/commands/app/share.ts"),
      import("../../src/cli/oclif/commands/app/share/list.ts"),
      import("../../src/cli/oclif/commands/app/share/stop.ts"),
    ]);

    const specs = modules.map((mod) => Object.values(mod).find((value) => isCommandSpec(value)));
    expect(specs, "every share command module must export a LandoCommandSpec").not.toContain(undefined);
    expect(specs.map((spec) => spec?.id)).toEqual(["app:share", "app:share:list", "app:share:stop"]);
    expect(specs[0]?.topLevelAlias).toBe(true);
    for (const spec of specs) {
      expect(spec?.bootstrap).toBe("app");
      expect(spec?.resultSchema, `${spec?.id} must carry a resultSchema`).toBeDefined();
      expect(spec?.flags, `${spec?.id} must define share skeleton flags`).toHaveProperty("format");
      expect(spec?.flags, `${spec?.id} must define provider selection`).toHaveProperty("provider");
    }
  });

  test("compiled dispatcher exposes share routes and renderers", async () => {
    const dispatchSource = await Bun.file(join(import.meta.dir, "../../src/cli/dispatch-app.ts")).text();
    const adapterSource = await Bun.file(
      join(import.meta.dir, "../../src/cli/cli-adapters/app-lifecycle.ts"),
    ).text();
    const shareSource = await Bun.file(join(import.meta.dir, "../../src/cli/commands/share.ts")).text();

    expect(adapterSource).toContain("renderShareResult(value, compiledFormat(input), ctx)");
    expect(adapterSource).toContain("renderShareListResult(value, options.format, ctx)");
    expect(adapterSource).toContain("renderShareStopResult(value, options.format, ctx)");
    expect(dispatchSource).toContain('argv[0] === "share"');
    expect(dispatchSource).toContain('argv[0] === "app:share:list"');
    expect(dispatchSource).toContain('argv[0] === "share:stop:app"');
    expect(shareSource).not.toContain('format === "json"');
    expect(shareSource).not.toContain("JSON.stringify");
  });

  test("share operations fail with TunnelProviderUnavailableError when no service is installed", async () => {
    await withTempShareApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");

      const startExit = await Effect.runPromiseExit(
        Effect.scoped(
          operations.appShare({ cwd: dir, target: serviceTarget, yes: true }) as unknown as Effect.Effect<
            unknown,
            unknown,
            Scope.Scope
          >,
        ),
      );
      const listExit = await Effect.runPromiseExit(
        operations.appShareList({ cwd: dir }) as unknown as Effect.Effect<unknown, unknown, never>,
      );
      const stopExit = await Effect.runPromiseExit(
        operations.appShareStop({ cwd: dir, sessionId: "tun_1" }) as unknown as Effect.Effect<
          unknown,
          unknown,
          never
        >,
      );

      for (const exit of [startExit, listExit, stopExit]) {
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const error = JSON.stringify(exit.cause.toJSON());
          expect(error).toContain("TunnelProviderUnavailableError");
          expect(error).toContain("plugin:add");
          expect(error).toContain("Lando 4.1");
        }
      }
    });
  });

  test("share operations round-trip a TestTunnelService session", async () => {
    await withTempShareApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      const layer = makeLandoRuntime({
        bootstrap: "app",
        plugins: { policy: "bundled-only", layers: [tunnelLayer, ...providerLayers] },
      });

      const session = (await Effect.runPromise(
        operations
          .appShare({ cwd: dir, target: serviceTarget, detach: true, yes: true })
          .pipe(Effect.provide(layer), Effect.scoped),
      )) as TunnelSession;
      const paths = makeLandoPaths();
      expect(await exists(paths.tunnelRegistryFile)).toBe(true);
      expect(await exists(join(paths.tunnelRunDir, `${session.id}.json`))).toBe(true);
      expect(await exists(join(paths.tunnelRunDir, `${session.id}.pid`))).toBe(true);
      const otherSession = await Effect.runPromise(
        Effect.scoped(
          TestTunnelService.service.start({ app: AppId.make("other-app"), target: serviceTarget }),
        ),
      );
      const listed = (await Effect.runPromise(
        operations.appShareList({ cwd: dir }).pipe(Effect.provide(layer)),
      )) as ReadonlyArray<TunnelSession>;
      const stopped = await Effect.runPromise(
        operations.appShareStop({ cwd: dir, sessionId: session.id }).pipe(Effect.provide(layer)),
      );
      const detached = await Effect.runPromise(TestTunnelService.observations.detachedState());

      expect(session.provider).toBe(TestTunnelService.service.id);
      expect(session.detached).toBe(true);
      expect(listed.map((entry) => entry.id)).toContain(session.id);
      expect(listed.map((entry) => entry.id)).not.toContain(otherSession.id);
      expect(stopped).toMatchObject({ sessionId: session.id, status: "stopped" });
      expect(detached.map((entry) => entry.operation)).toEqual(expect.arrayContaining(["record", "remove"]));
      expect(await exists(paths.tunnelRegistryFile)).toBe(true);
      expect(await exists(join(paths.tunnelRunDir, `${session.id}.json`))).toBe(false);
      expect(await exists(join(paths.tunnelRunDir, `${session.id}.pid`))).toBe(false);
    });
  });

  test("share stop rejects a missing session id before provider stop", async () => {
    await withTempShareApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      const layer = makeLandoRuntime({
        bootstrap: "app",
        plugins: { policy: "bundled-only", layers: [tunnelLayer, ...providerLayers] },
      });

      const exit = await Effect.runPromiseExit(
        operations.appShareStop({ cwd: dir, sessionId: "" }).pipe(Effect.provide(layer)),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause.toJSON())).toContain("Expected a tunnel identifier");
      }
    });
  });

  test("App handle exposes share, shareList, and shareStop", async () => {
    await withTempShareApp(async () => {
      const result = await Effect.runPromise(
        resolveApp().pipe(
          Effect.flatMap((app) =>
            Effect.gen(function* () {
              const session = yield* app.share({ target: serviceTarget, detach: true, yes: true });
              const listed = yield* app.shareList();
              const stopped = yield* app.shareStop({ sessionId: session.id });
              return { session, listed, stopped };
            }),
          ),
          Effect.scoped,
          Effect.provide(
            makeLandoRuntime({
              bootstrap: "app",
              plugins: { policy: "bundled-only", layers: [tunnelLayer, ...providerLayers] },
            }),
          ),
        ),
      );

      expect(result.session.status).toBe("ready");
      expect(result.listed.map((entry) => entry.id)).toContain(result.session.id);
      expect(result.stopped).toMatchObject({ sessionId: result.session.id, status: "stopped" });
    });
  });
});
