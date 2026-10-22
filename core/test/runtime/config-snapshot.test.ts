import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService, PathsService, PluginTrustStore, StateStore } from "@lando/sdk/services";
import { Context, Effect, Layer, Schema } from "effect";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

test("app runtime acquires config once and pins reads after the source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-config-snapshot-"));
  const file = join(root, "config.yml");
  await writeFile(file, "router:\n  httpPort: 8123\n");
  const acquisitionModule: typeof import("@lando/paths/config-sources") = await import(
    Bun.resolveSync(
      "@lando/paths/config-sources",
      Bun.resolveSync("@lando/engine/services/config", import.meta.dir),
    )
  );
  const acquisition = spyOn(acquisitionModule, "readGlobalConfigSources");
  try {
    const layer = makeLandoRuntime({
      bootstrap: "app",
      config: { userConfRoot: root, userDataRoot: join(root, "data"), userCacheRoot: join(root, "cache") },
      configSources: { env: false },
    });
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer);
          const service = Context.get(context, ConfigService);
          const before = yield* service.load;
          yield* Effect.promise(() => writeFile(file, "router:\n  httpPort: 8124\n"));
          return { before, after: yield* service.load, port: yield* service.get("router") };
        }),
      ),
    );
    expect(acquisition).toHaveBeenCalledTimes(1);
    expect(values.before.router?.httpPort).toBe(8123);
    expect(values.after).toBe(values.before);
    expect(values.port?.httpPort).toBe(8123);
  } finally {
    acquisition.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("two runtimes keep independent host configs and roots in one process", async () => {
  const runtimes = [8123, 8124].map((port) =>
    makeLandoRuntime({
      bootstrap: "minimal",
      configSources: { user: false, env: false },
      config: { router: { httpPort: port }, userDataRoot: `/tmp/lando-snapshot-${port}` },
    }),
  );
  const values = await Promise.all(
    runtimes.map((layer) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return { config: yield* (yield* ConfigService).load, paths: yield* PathsService };
        }).pipe(Effect.provide(layer)),
      ),
    ),
  );
  expect(values.map((value) => value.config.router?.httpPort)).toEqual([8123, 8124]);
  expect(values.map((value) => value.paths.roots.userDataRoot)).toEqual([
    "/tmp/lando-snapshot-8123",
    "/tmp/lando-snapshot-8124",
  ]);
});

test("doctor passes its validated snapshot to provider bootstrap without reacquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-snapshot-"));
  const acquisitionModule: typeof import("@lando/paths/config-sources") = await import(
    Bun.resolveSync(
      "@lando/paths/config-sources",
      Bun.resolveSync("@lando/engine/services/config", import.meta.dir),
    )
  );
  const acquisition = spyOn(acquisitionModule, "readGlobalConfigSources");
  try {
    const report = await Effect.runPromise(
      resilientDoctorReport({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "none",
            configSources: { user: false, env: false },
            config: {
              userConfRoot: root,
              userDataRoot: join(root, "data"),
              userCacheRoot: join(root, "cache"),
            },
          }),
        ),
      ),
    );
    expect(report.globalConfig?.status).toBe("pass");
    expect(acquisition).toHaveBeenCalledTimes(1);
  } finally {
    acquisition.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("nested independent runtimes keep their own config and roots", async () => {
  // Given an outer runtime with a distinct snapshot.
  const runtime = (port: number) =>
    makeLandoRuntime({
      bootstrap: "minimal",
      configSources: { user: false, env: false },
      config: { router: { httpPort: port }, userDataRoot: `/tmp/lando-nested-${port}` },
    });
  // When constructing and using a second runtime inside the first runtime context.
  const values = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* (yield* ConfigService).load;
      const inner = yield* Effect.gen(function* () {
        return { config: yield* (yield* ConfigService).load, roots: (yield* PathsService).roots };
      }).pipe(Effect.provide(runtime(8457)));
      return { outer, inner };
    }).pipe(Effect.provide(runtime(8456))),
  );
  // Then neither config nor resolved roots leak across runtimes.
  expect(values.outer.router?.httpPort).toBe(8456);
  expect(values.inner.config.router?.httpPort).toBe(8457);
  expect(values.inner.roots.userDataRoot).toBe("/tmp/lando-nested-8457");
});

test("state buckets and plugin trust use the runtime host roots", async () => {
  // Given host-selected roots that differ from ambient roots.
  const root = await mkdtemp(join(tmpdir(), "lando-retained-roots-"));
  try {
    // When opening state and writing plugin trust through the runtime services.
    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        const paths = yield* PathsService;
        const bucket = yield* (yield* StateStore).open({
          root: "userData",
          key: "root-proof",
          schema: Schema.String,
          version: 1,
        });
        yield* bucket.set("host-root");
        yield* (yield* PluginTrustStore).trustPlugin("@example/retained");
        return paths;
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "minimal",
            configSources: { user: false, env: false },
            config: {
              userConfRoot: join(root, "conf"),
              userDataRoot: join(root, "data"),
              userCacheRoot: join(root, "cache"),
            },
          }),
        ),
      ),
    );
    // Then both persisted artifacts live under the same authority as PathsService.
    expect(await Bun.file(join(paths.roots.userDataRoot, "root-proof")).exists()).toBe(true);
    expect(await Bun.file(paths.pluginTrustFile).text()).toContain("@example/retained");
    expect(paths.pluginTrustFile.startsWith(paths.roots.userConfRoot)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notify validation accepts host-explicit global plugin commands", async () => {
  // Given a host-provided plugin that contributes a global command.
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/notify-host",
    version: "1.0.0",
    api: 4,
    contributes: { commands: ["example:release"] },
  });
  // When the runtime validates its notification policy before building plugins.
  const config = await Effect.runPromise(
    Effect.flatMap(ConfigService, (service) => service.load).pipe(
      Effect.provide(
        makeLandoRuntime({
          bootstrap: "minimal",
          configSources: { user: false, env: false },
          plugins: {
            policy: { mode: "explicit", manifests: [{ manifest, entry: { name: manifest.name, manifest } }] },
          },
          config: { notify: { commands: ["example:release"] } },
        }),
      ),
    ),
  );
  // Then the explicit command is valid even though it is not a built-in id.
  expect(config.notify?.commands).toEqual(["example:release"]);
});
