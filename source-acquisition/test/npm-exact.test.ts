import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeSourceStore } from "../src/index.ts";
import { verifyNpmFile } from "../src/npm-authored-integrity.ts";
import { withTestSources } from "../src/testing.ts";
import { makeFakeNpmRegistry, npmVersion, packageTarball, sriSha512 } from "./support.ts";

const bundle = "console.log('manager');\n";
const bytes = packageTarball({ "bin/yarn.js": bundle });
const tarball = "https://registry.test/manager.tgz";
const registryFor = (name: string) => {
  const npm = makeFakeNpmRegistry();
  npm.setPackument(
    name,
    npmVersion({ name, version: "3.0.0", dist: { tarball, integrity: sriSha512(bytes) } }),
  );
  npm.setTarball(tarball, bytes);
  return npm;
};

test.each(["sha224", "sha256", "sha384", "sha512"] as const)(
  "checks the original npm tarball %s and makes zero warm requests",
  async (algorithm) => {
    const name = "pnpm";
    const npm = registryFor(name);
    const hex = createHash(algorithm).update(bytes).digest("hex");
    await withTestSources({}, ({ stateStore }) =>
      Effect.gen(function* () {
        const store = makeSourceStore({ stateStore, transports: { npmRegistry: npm.transport } });
        const acquire = (integrity: string, network: boolean) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* store.session;
              return yield* session.acquireExactNpm(
                { name, version: "3.0.0", integrity: { algorithm, hex: integrity } },
                { network },
              );
            }),
          );
        const rejected = yield* Effect.result(acquire("f".repeat(hex.length), true));
        expect(rejected).toMatchObject({ _tag: "Failure", failure: { kind: "integrity-mismatch" } });
        expect(yield* Effect.result(acquire(hex, false))).toMatchObject({
          _tag: "Failure",
          failure: { kind: "offline-miss" },
        });
        const cold = yield* acquire(hex, true);
        expect(yield* acquire(hex, false)).toMatchObject({ key: cold.key, treeDigest: cold.treeDigest });
        expect(npm.calls.packument).toEqual([name, name]);
        expect(npm.calls.tarball).toHaveLength(2);
        npm.setRegistry("https://different.test");
        expect(yield* Effect.result(acquire(hex, false))).toMatchObject({
          _tag: "Failure",
          failure: { kind: "offline-miss" },
        });
        expect(npm.calls.packument).toEqual([name, name]);
      }),
    );
  },
);

test("authenticates Berry's bundle separately from registry tarball bytes", async () => {
  const name = "@yarnpkg/cli-dist";
  const npm = registryFor(name);
  const coordinate = { name, version: "3.0.0" };
  const integrity = { algorithm: "sha512", file: "bin/yarn.js" } as const;
  await withTestSources({ npmRegistry: npm.transport }, ({ session }) =>
    Effect.gen(function* () {
      const wrong = createHash("sha512").update(bytes).digest("hex");
      expect(
        yield* Effect.result(
          session.acquireExactNpm({ ...coordinate, integrity: { ...integrity, hex: wrong } }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { kind: "integrity-mismatch" } });
      const hex = createHash("sha512").update(bundle).digest("hex");
      const source = { ...coordinate, integrity: { ...integrity, hex } };
      const cold = yield* session.acquireExactNpm(source);
      expect(yield* session.acquireExactNpm(source, { network: false })).toMatchObject({ key: cold.key });
      expect(npm.calls.packument).toEqual([name, name]);
    }),
  );
});

test.each(["regular file", "symlinked file"] as const)(
  "hashes an authored file only when it is a %s",
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-npm-file-")));
    try {
      await mkdir(join(root, "package", "bin"), { recursive: true });
      await writeFile(join(root, "outside.js"), bundle);
      const file = join(root, "package", "bin", "yarn.js");
      if (kind === "symlinked file") await symlink(join(root, "outside.js"), file);
      else await writeFile(file, bundle);
      const hex = createHash("sha512").update(bundle).digest("hex");
      const result = await Effect.runPromise(
        Effect.result(verifyNpmFile("yarn", { algorithm: "sha512", hex, file: "bin/yarn.js" })(root)),
      );
      expect(result._tag).toBe(kind === "regular file" ? "Success" : "Failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
