import { describe, expect, test } from "bun:test";
import { readFile, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { sourceRecords } from "../src/records.ts";
import { withTestSources } from "../src/testing.ts";
import { makeFakeNpmRegistry, npmVersion, packageTarball, shasumOf, sriSha512 } from "./support.ts";

const packageRoot = (snapshotRoot: string): string => join(snapshotRoot, "package");

describe("source-acquisition npm", () => {
  test.each([
    {
      label: "host",
      firstRegistry: "https://first.test/npm",
      secondRegistry: "https://second.test/npm",
      display: "https://first.test/npm",
    },
    {
      label: "query identity",
      firstRegistry: "https://user:password@registry.test/npm?route=first",
      secondRegistry: "https://user:password@registry.test/npm?route=second",
      display: "https://registry.test/npm",
    },
    {
      label: "trailing slashes",
      firstRegistry: "https://first.test/npm///",
      secondRegistry: "https://second.test/npm///",
      display: "https://first.test/npm///",
    },
  ])(
    "registry swaps by $label keep independent indexes and immutable archive entries",
    async ({ firstRegistry, secondRegistry, display }) => {
      const firstBytes = packageTarball({ "package.json": '{"build":1}' });
      const secondBytes = packageTarball({ "package.json": '{"build":2}' });
      const tarball = "https://example.test/package.tgz";
      const npm = makeFakeNpmRegistry({ registry: firstRegistry });
      npm.setPackument(
        "pkg",
        npmVersion({ name: "pkg", version: "1.0.0", dist: { tarball, integrity: sriSha512(firstBytes) } }),
      );
      npm.setTarball(tarball, firstBytes);
      await withTestSources({ npmRegistry: npm.transport }, ({ session, stateStore }) =>
        Effect.gen(function* () {
          const first = yield* session.acquireNpm({ name: "pkg", selector: "1.0.0" });
          npm.setRegistry(secondRegistry);
          expect((yield* session.lookupNpm({ name: "pkg", version: "1.0.0" }))?.key).toEqual(first.key);
          npm.setPackument(
            "pkg",
            npmVersion({
              name: "pkg",
              version: "1.0.0",
              dist: { tarball, integrity: sriSha512(secondBytes) },
            }),
          );
          npm.setTarball(tarball, secondBytes);
          const second = yield* session.acquireNpm({ name: "pkg", selector: "1.0.0" });
          expect(second.key).not.toEqual(first.key);
          expect((yield* session.lookupNpm({ name: "pkg", version: "1.0.0" }))?.key).toEqual(second.key);
          npm.setRegistry(firstRegistry);
          expect((yield* session.lookupNpm({ name: "pkg", version: "1.0.0" }))?.key).toEqual(first.key);
          expect(
            yield* Effect.promise(() => readFile(join(first.root, "package", "package.json"), "utf8")),
          ).toBe('{"build":1}');
          expect(npm.calls.tarball).toHaveLength(2);
          const bucket = yield* sourceRecords(stateStore).npm(first.pin.registry, "pkg", "1.0.0");
          expect((yield* bucket.get)?.registry).toBe(display);
        }),
      );
    },
  );

  test("acquire verifies integrity and materializes package tree", async () => {
    const bytes = packageTarball({
      "package.json": JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
      "index.js": "export default 1;\n",
    });
    const tarball = "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz";
    const integrity = sriSha512(bytes);
    const npm = makeFakeNpmRegistry();
    npm.setPackument(
      "@scope/pkg",
      npmVersion({
        name: "@scope/pkg",
        version: "1.0.0",
        dist: { tarball, integrity },
      }),
    );
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireNpm({ name: "@scope/pkg", selector: "1.0.0" });
        expect(snap.pin.version).toBe("1.0.0");
        expect(snap.key.kind).toBe("archive");
        const pkgJson = yield* Effect.promise(() =>
          readFile(join(packageRoot(snap.root), "package.json"), "utf8"),
        );
        expect(JSON.parse(pkgJson).name).toBe("@scope/pkg");
        expect(npm.calls.tarball).toHaveLength(1);

        const again = yield* session.materializeNpm(snap.pin);
        expect(again.root).toBe(snap.root);
        expect(again.key).toEqual(snap.key);
        expect(npm.calls.tarball).toHaveLength(1);
      }),
    );
  });

  test("missing integrity fails with integrity-missing", async () => {
    const bytes = packageTarball({ "package.json": '{"name":"x","version":"1.0.0"}' });
    const tarball = "https://registry.npmjs.org/x/-/x-1.0.0.tgz";
    const npm = makeFakeNpmRegistry();
    npm.setPackument("x", npmVersion({ name: "x", version: "1.0.0", dist: { tarball } }));
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(session.acquireNpm({ name: "x", selector: "1.0.0" }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.kind).toBe("integrity-missing");
      }),
    );
  });

  test("integrity mismatch fails with integrity-mismatch", async () => {
    const bytes = packageTarball({ "package.json": '{"name":"y","version":"1.0.0"}' });
    const tarball = "https://registry.npmjs.org/y/-/y-1.0.0.tgz";
    const npm = makeFakeNpmRegistry();
    npm.setPackument(
      "y",
      npmVersion({
        name: "y",
        version: "1.0.0",
        dist: {
          tarball,
          integrity:
            "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        },
      }),
    );
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(session.acquireNpm({ name: "y", selector: "1.0.0" }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.kind).toBe("integrity-mismatch");
      }),
    );
  });

  test("shasum verifies when integrity is absent", async () => {
    const bytes = packageTarball({ "package.json": '{"name":"z","version":"2.0.0"}' });
    const tarball = "https://registry.npmjs.org/z/-/z-2.0.0.tgz";
    const npm = makeFakeNpmRegistry();
    npm.setPackument(
      "z",
      npmVersion({
        name: "z",
        version: "2.0.0",
        dist: { tarball, shasum: shasumOf(bytes) },
      }),
    );
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireNpm({ name: "z", selector: "2.0.0" });
        expect(snap.pin.version).toBe("2.0.0");
      }),
    );
  });

  test("registry integrity swap replaces npm index entry", async () => {
    const v1 = packageTarball({ "package.json": '{"name":"swap","version":"1.0.0","build":1}' });
    const v2 = packageTarball({ "package.json": '{"name":"swap","version":"1.0.0","build":2}' });
    const tarball = "https://registry.npmjs.org/swap/-/swap-1.0.0.tgz";
    const npm = makeFakeNpmRegistry();
    npm.setPackument(
      "swap",
      npmVersion({
        name: "swap",
        version: "1.0.0",
        dist: { tarball, integrity: sriSha512(v1) },
      }),
    );
    npm.setTarball(tarball, v1);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const first = yield* session.acquireNpm({ name: "swap", selector: "1.0.0" });
        const firstBuild = JSON.parse(
          yield* Effect.promise(() => readFile(join(packageRoot(first.root), "package.json"), "utf8")),
        ).build;
        expect(firstBuild).toBe(1);

        const pin2 = {
          ...first.pin,
          dist: { tarball, integrity: sriSha512(v2) },
        };
        npm.setTarball(tarball, v2);
        const second = yield* session.materializeNpm(pin2);
        const secondBuild = JSON.parse(
          yield* Effect.promise(() => readFile(join(packageRoot(second.root), "package.json"), "utf8")),
        ).build;
        expect(secondBuild).toBe(2);
        expect(second.key).not.toEqual(first.key);
        expect(npm.calls.tarball).toHaveLength(2);
        const original = JSON.parse(
          yield* Effect.promise(() => readFile(join(packageRoot(first.root), "package.json"), "utf8")),
        );
        expect(original.build).toBe(1);
      }),
    );
  });

  test("lookupNpm uses its verified coordinate index without resolving or downloading", async () => {
    const bytes = packageTarball({ "package.json": '{"name":"look","version":"1.0.0"}' });
    const tarball = "https://registry.npmjs.org/look/-/look-1.0.0.tgz";
    const registry = "https://registry.npmjs.org/";
    const npm = makeFakeNpmRegistry({ registry });
    npm.setPackument(
      "look",
      npmVersion({
        name: "look",
        version: "1.0.0",
        dist: { tarball, integrity: sriSha512(bytes) },
      }),
    );
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireNpm({ name: "look", selector: "1.0.0" });
        const hit = yield* session.lookupNpm({ name: "look", version: "1.0.0" });
        expect(hit?.key).toEqual(snap.key);
        expect(npm.calls.packument).toHaveLength(1);
        expect(npm.calls.tarball).toHaveLength(1);
      }),
    );
  });

  describe("lookupNpm when the configured registry has no usable record", () => {
    const publish = (npm: ReturnType<typeof makeFakeNpmRegistry>, registry: string, build: number) => {
      const bytes = packageTarball({ "package.json": `{"build":${build}}` });
      const tarball = `https://example.test/build-${build}.tgz`;
      npm.setRegistry(registry);
      npm.setPackument(
        "pinned",
        npmVersion({ name: "pinned", version: "2.0.0", dist: { tarball, integrity: sriSha512(bytes) } }),
      );
      npm.setTarball(tarball, bytes);
    };
    const switchableConfig = (npm: ReturnType<typeof makeFakeNpmRegistry>) => {
      const config = { readable: true };
      return {
        config,
        transport: {
          ...npm.transport,
          registryFor: (name: string) => {
            if (!config.readable) throw new Error("Could not read npm user config.");
            return npm.transport.registryFor(name);
          },
        },
      };
    };
    const setLastUse = (snapshotRoot: string, seconds: number) =>
      Effect.promise(() => utimes(join(dirname(snapshotRoot), "entry.json"), seconds, seconds));

    test("serves a pinned version cached from another registry when npm config is unreadable", async () => {
      const npm = makeFakeNpmRegistry();
      publish(npm, "https://first.test/npm", 1);
      const registry = switchableConfig(npm);
      await withTestSources({ npmRegistry: registry.transport }, ({ session }) =>
        Effect.gen(function* () {
          const cached = yield* session.acquireNpm({ name: "pinned", selector: "2.0.0" });
          const calls = { packument: npm.calls.packument.length, tarball: npm.calls.tarball.length };
          registry.config.readable = false;
          const hit = yield* session.lookupNpm({ name: "pinned", version: "2.0.0" });
          expect(hit?.key).toEqual(cached.key);
          expect(npm.calls.packument).toHaveLength(calls.packument);
          expect(npm.calls.tarball).toHaveLength(calls.tarball);
        }),
      );
    });

    test("surfaces the registry failure when nothing is cached for that version", async () => {
      const registry = switchableConfig(makeFakeNpmRegistry());
      registry.config.readable = false;
      await withTestSources({ npmRegistry: registry.transport }, ({ session }) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(session.lookupNpm({ name: "pinned", version: "2.0.0" }));
          expect(failure.message).toContain("Could not read npm user config.");
        }),
      );
    });

    test("prefers the most recently used cached archive across registries", async () => {
      const npm = makeFakeNpmRegistry();
      const registry = switchableConfig(npm);
      await withTestSources({ npmRegistry: registry.transport }, ({ session }) =>
        Effect.gen(function* () {
          publish(npm, "https://first.test/npm", 1);
          const first = yield* session.acquireNpm({ name: "pinned", selector: "2.0.0" });
          publish(npm, "https://second.test/npm", 2);
          const second = yield* session.acquireNpm({ name: "pinned", selector: "2.0.0" });
          registry.config.readable = false;
          yield* setLastUse(first.root, 2_000_000_000);
          yield* setLastUse(second.root, 1_000_000_000);
          expect((yield* session.lookupNpm({ name: "pinned", version: "2.0.0" }))?.key).toEqual(first.key);
          yield* setLastUse(second.root, 2_100_000_000);
          expect((yield* session.lookupNpm({ name: "pinned", version: "2.0.0" }))?.key).toEqual(second.key);
        }),
      );
    });
  });

  test("resolveNpm pin.registry strips credentials", async () => {
    const bytes = packageTarball({ "package.json": '{"name":"cred","version":"1.0.0"}' });
    const tarball = "https://registry.example/cred/-/cred-1.0.0.tgz";
    const npm = makeFakeNpmRegistry({ registry: "https://user:secret@registry.example/npm/" });
    npm.setPackument(
      "cred",
      npmVersion({
        name: "cred",
        version: "1.0.0",
        dist: { tarball, integrity: sriSha512(bytes) },
      }),
    );
    npm.setTarball(tarball, bytes);

    await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
      Effect.gen(function* () {
        const pin = yield* session.resolveNpm({ name: "cred", selector: "1.0.0" });
        expect(pin.registry).not.toContain("secret");
        expect(pin.registry).not.toContain("user:");
        expect(pin.registry).toContain("registry.example");
      }),
    );
  });
});
