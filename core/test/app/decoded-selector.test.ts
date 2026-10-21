import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { AbsolutePath, LandofileShape, LogSourceId, ProviderId, ServiceName } from "@lando/core/schema";
import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { rememberVersionConstraintEntries } from "@lando/landofile/version-constraint";

const decode = Schema.decodeUnknownSync(LandofileShape);
const web = ServiceName.make("web");

const decodedLandofile = (includes: readonly string[] = []) =>
  decode(
    {
      name: "decoded-selector",
      lando: "*",
      provider: TestRuntimeProvider.id,
      includes,
      services: {
        web: { image: "node:lts", home: false, logs: [{ path: "/var/log/app.log" }] },
      },
    },
    { onExcessProperty: "error", errors: "all" },
  );

const appLayer = (root: string) =>
  makeLandoRuntime({
    bootstrap: "app",
    cwd: root,
    config: {
      userDataRoot: AbsolutePath.make(join(root, "data")),
      userCacheRoot: AbsolutePath.make(join(root, "cache")),
      userConfRoot: AbsolutePath.make(join(root, "conf")),
    },
    plugins: {
      policy: "bundled-only",
      layers: [
        makeTestStateStore().layer,
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
            capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
            select: () => Effect.succeed(TestRuntimeProvider),
          }),
        ),
      ],
    },
  });

const withAppRoot = async (run: (root: AbsolutePath) => Promise<void>) => {
  const root = AbsolutePath.make(await realpath(await mkdtemp(join(tmpdir(), "decoded-selector-"))));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("resolves transformed log values when a decoded selector has no includes", async () => {
  await withAppRoot(async (root) => {
    // Given: strict authored decoding creates the runtime-only log fields.
    const landofile = decodedLandofile();

    // When: the public API resolves the decoded object at its authoritative root.
    const result = await Effect.runPromise(
      resolveApp({ landofile, root }).pipe(
        Effect.flatMap((app) => app.plan.pipe(Effect.map((plan) => ({ root: app.root, plan })))),
        Effect.scoped,
        Effect.provide(appLayer(root)),
      ),
    );

    // Then: the handle and plan retain the root and canonical log semantics.
    expect(result.root).toBe(root);
    expect(result.plan.root).toBe(root);
    expect(result.plan.services[web]?.logSources).toEqual([
      {
        id: LogSourceId.make("app.log"),
        path: AbsolutePath.make("/var/log/app.log"),
        stream: "stderr",
        strategy: "follow",
        required: false,
        timestamps: false,
      },
    ]);
  });
});

test("composes a relative include when the decoded selector carries transformed logs", async () => {
  await withAppRoot(async (root) => {
    // Given: a fragment exists only at the selected root, not the host cwd.
    await Bun.write(
      join(root, "fragment.yml"),
      "services:\n  web:\n    environment:\n      FROM_FRAGMENT: included\n",
    );
    const landofile = decodedLandofile(["fragment.yml"]);

    // When: the public API composes the fragment below the decoded selector.
    const plan = await Effect.runPromise(
      resolveApp({ landofile, root }).pipe(
        Effect.flatMap((app) => app.plan),
        Effect.scoped,
        Effect.provide(appLayer(root)),
      ),
    );

    // Then: root resolution, fragment contribution, and decoded logs survive.
    expect(plan.root).toBe(root);
    expect(plan.services[web]?.environment.FROM_FRAGMENT).toBe("included");
    expect(plan.services[web]?.logSources).toEqual(landofile.services?.[web]?.logs);
  });
});

for (const includes of [[], ["fragment.yml"]]) {
  test(`retains shadowed version provenance when the decoded selector has ${includes.length} includes`, async () => {
    await withAppRoot(async (root) => {
      // Given: the visible range is valid but a remembered lower layer is incompatible.
      await Bun.write(join(root, "fragment.yml"), "lando: '*'\n");
      const source = join(root, ".lando.base.yml");
      const landofile = rememberVersionConstraintEntries(decodedLandofile(includes), [
        { range: ">=99", source, layer: "base", order: 0 },
      ]);

      // When: the public API resolves the decoded object.
      const error = await Effect.runPromise(
        resolveApp({ landofile, root }).pipe(Effect.scoped, Effect.provide(appLayer(root)), Effect.flip),
      );

      // Then: encoding must not drop the constraint or its original source.
      expect(error).toMatchObject({
        _tag: "AppResolveError",
        cause: { _tag: "LandofileVersionConstraintError", constraints: [{ range: ">=99", source }] },
      });
    });
  });
}

test("rejects authored runtime-only log fields when they come from an included fragment", async () => {
  await withAppRoot(async (root) => {
    // Given: an included service authors a field allowed only in decoded log values.
    const source = join(root, "fragment.yml");
    await Bun.write(
      source,
      "services:\n  other:\n    image: node:lts\n    home: false\n    logs:\n      - path: /var/log/other.log\n        required: false\n",
    );

    // When: a lawful decoded selector includes that invalid authored fragment.
    const error = await Effect.runPromise(
      resolveApp({ landofile: decodedLandofile(["fragment.yml"]), root }).pipe(
        Effect.scoped,
        Effect.provide(appLayer(root)),
        Effect.flip,
      ),
    );

    // Then: strict authored validation still rejects the excess field at its source.
    expect(error).toMatchObject({
      _tag: "AppResolveError",
      cause: {
        _tag: "LandofileValidationError",
        file: source,
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["services", "other", "logs", 0, "required"],
            source: expect.objectContaining({ file: source }),
          }),
        ]),
      },
    });
  });
});
