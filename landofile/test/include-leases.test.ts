import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateStoreShape } from "@lando/sdk/services";
import type { GitTransport } from "@lando/source-acquisition";
import { Effect, Schema } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { resolveAuthoredIncludes, updateAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const Lease = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ kind: Schema.Literal("git"), commit: Schema.String })),
});
test.each(["direct", "layers", "update"] as const)(
  "%s holds one source lease through lock publication",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-include-lease-"));
    const cacheRoot = join(root, "cache");
    const observations: { leases: number; commits: readonly string[] }[] = [];
    const underlying = makeTestLandofileStateStore(cacheRoot);
    const stateStore: StateStoreShape = {
      ...underlying,
      open: (spec) =>
        underlying.open(spec).pipe(
          Effect.map((bucket) => ({
            ...bucket,
            set: (value) =>
              Effect.gen(function* () {
                if (spec.key === ".lando.lock.yml") {
                  const files = yield* Effect.promise(() => readdir(join(cacheRoot, "sources", ".leases")));
                  const leases = yield* Effect.promise(() =>
                    Promise.all(
                      files.map(async (file) =>
                        Schema.decodeUnknownSync(Schema.fromJsonString(Lease))(
                          await Bun.file(join(cacheRoot, "sources", ".leases", file)).text(),
                        ),
                      ),
                    ),
                  );
                  observations.push({
                    leases: files.length,
                    commits: leases.flatMap((lease) => lease.keys.map((key) => key.commit)).sort(),
                  });
                }
                yield* bucket.set(value);
              }),
          })),
        ),
    };
    const git: GitTransport = {
      fetch: async ({ url, dest }) => {
        const name = url.includes("/base.git") ? "base" : "canonical";
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, "fragment.yml"), `services:\n  ${name}:\n    image: alpine\n`);
        return { commit: (name === "base" ? "a" : "b").repeat(40) };
      },
    };
    const ports = makeTestLandofilePorts(cacheRoot, cacheRoot, { git });
    const entries = ["base", "canonical"].map((repo) => ({
      source: `github:acme/${repo}`,
      path: "fragment.yml",
    }));
    try {
      switch (mode) {
        case "direct":
          await Effect.runPromise(
            resolveAuthoredIncludes({
              appRoot: root,
              cacheRoot,
              ports,
              stateStore,
              landofile: { name: "lease", includes: entries },
            }),
          );
          break;
        case "update":
          await Effect.runPromise(
            updateAuthoredIncludes({
              appRoot: root,
              cacheRoot,
              ports,
              stateStore,
              landofile: { name: "lease", includes: entries },
            }),
          );
          break;
        case "layers":
          await writeFile(
            join(root, ".lando.base.yml"),
            "includes:\n  - source: github:acme/base\n    path: fragment.yml\n",
          );
          await writeFile(
            join(root, ".lando.yml"),
            "name: lease\nincludes:\n  - source: github:acme/canonical\n    path: fragment.yml\n",
          );
          await Effect.runPromise(
            loadLandofileLayers(root, join(root, ".lando.yml"), {
              ports,
              stateStore,
              templates: { modules: [] },
            }),
          );
          break;
        default: {
          const exhaustive: never = mode;
          return exhaustive;
        }
      }
      expect(observations).toEqual([{ leases: 1, commits: ["a".repeat(40), "b".repeat(40)] }]);
      expect(await readdir(join(cacheRoot, "sources", ".leases"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
