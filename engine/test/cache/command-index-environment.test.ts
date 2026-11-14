import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileEnvironmentDependencies } from "@lando/landofile/load-expression-provenance";
import { Effect } from "effect";
import {
  readAppCommandCache,
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { HostExecutionDefaults } from "../../src/services/host-execution-context.ts";

const landofile = (
  dependencies: { readonly _tag: "Names"; readonly names: readonly string[] } | { readonly _tag: "Complete" },
  name = "environment",
) => rememberLandofileEnvironmentDependencies({ name }, dependencies);

test.each([
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: "one", B: "two" },
    after: { B: "two", A: "one" },
    fresh: true,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: "one" },
    after: { A: "two" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: {},
    after: { A: "" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: "" },
    after: {},
    fresh: false,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: undefined },
    after: { A: "" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: undefined },
    after: {},
    fresh: false,
  },
  {
    dependencies: { _tag: "Names" as const, names: ["A"] },
    before: { A: "one" },
    after: { A: "one", OLDPWD: "/tmp/other", LANDO_RENDERER: "json" },
    fresh: true,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: "one", B: "two" },
    after: { B: "two", A: "one" },
    fresh: true,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: "one" },
    after: { A: "two" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: "one" },
    after: { A: "one", OLDPWD: "/tmp/other" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: {},
    after: { A: "" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: "" },
    after: {},
    fresh: false,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: undefined },
    after: { A: "" },
    fresh: false,
  },
  {
    dependencies: { _tag: "Complete" as const },
    before: { A: undefined },
    after: {},
    fresh: false,
  },
])(
  "compares captured environment inputs by recorded dependencies %#",
  async ({ dependencies, before, after, fresh }) => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-index-environment-"));
    const options = {
      cwd,
      cacheRoot: join(cwd, "cache"),
      landofile: landofile(dependencies),
      entries: [],
    };
    const canary = "private-environment-cache-canary";
    try {
      await writeFile(join(cwd, ".lando.yml"), "name: environment\n");
      const path = await Effect.runPromise(
        writeAppCommandCacheStrict({ ...options, env: { ...before, PRIVATE_CANARY: canary }, now: () => 1 }),
      );
      if (path === undefined) throw new TypeError("Fixture requires a written cache");
      const env = { ...after, PRIVATE_CANARY: canary };

      const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed({ ...options, env }));
      expect(receipt).toMatchObject(
        fresh ? { status: "fresh" } : { status: "stale", staleReason: "environment" },
      );
      expect((await Effect.runPromise(readAppCommandCache({ ...options, env }))) === null).toBe(!fresh);
      expect(Buffer.from(await readFile(path)).includes(Buffer.from(canary))).toBe(false);

      await Effect.runPromise(writeAppCommandCacheStrict({ ...options, env, now: () => 2 }));
      const rebuilt = await Effect.runPromise(readAppCommandCache({ ...options, env }));
      expect(rebuilt?.generatedAtMs).toBe(fresh ? 1 : 2);
      expect(rebuilt?.sourceEnvironment._tag).toBe(dependencies._tag);
      if (dependencies._tag === "Names") {
        expect(rebuilt?.sourceEnvironment).toMatchObject({ names: [...dependencies.names] });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("keeps Names caches fresh across OLDPWD and LANDO_RENDERER only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-index-irrelevant-environment-"));
  const options = {
    cwd,
    cacheRoot: join(cwd, "cache"),
    landofile: landofile({ _tag: "Names", names: ["READ_KEY"] }),
    entries: [],
  };
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: environment\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        ...options,
        env: { READ_KEY: "stable", OLDPWD: "/a", LANDO_RENDERER: "default" },
        now: () => 1,
      }),
    );
    const receipt = await Effect.runPromise(
      readAppCommandCacheForCwdDetailed({
        ...options,
        env: { READ_KEY: "stable", OLDPWD: "/b", LANDO_RENDERER: "json" },
      }),
    );
    expect(receipt).toMatchObject({ status: "fresh" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("never stores the private canary under Names or Complete", async () => {
  for (const dependencies of [{ _tag: "Names" as const, names: ["A"] }, { _tag: "Complete" as const }]) {
    const cwd = await mkdtemp(join(tmpdir(), "lando-index-canary-"));
    const canary = "private-environment-cache-canary-absent";
    try {
      await writeFile(join(cwd, ".lando.yml"), "name: environment\n");
      const path = await Effect.runPromise(
        writeAppCommandCacheStrict({
          cwd,
          cacheRoot: join(cwd, "cache"),
          landofile: landofile(dependencies),
          entries: [],
          env: { A: "one", PRIVATE_CANARY: canary },
          now: () => 1,
        }),
      );
      if (path === undefined) throw new TypeError("Fixture requires a written cache");
      expect(Buffer.from(await readFile(path)).includes(Buffer.from(canary))).toBe(false);
      expect(Buffer.from(await readFile(path)).includes(Buffer.from("PRIVATE_CANARY"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("engine cache defaults inherit a captured host environment before ambient defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-index-host-environment-"));
  const options = {
    cwd,
    cacheRoot: join(cwd, "cache"),
    landofile: landofile({ _tag: "Names", names: ["CAPTURED_ENV"] }, "captured"),
    entries: [],
  };
  const env = { CAPTURED_ENV: "host-only" };
  const host = { cwd, env, platform: process.platform };
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: captured\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict(options).pipe(Effect.provideService(HostExecutionDefaults, host)),
    );

    expect(await Effect.runPromise(readAppCommandCache({ ...options, env }))).not.toBeNull();
    expect(
      await Effect.runPromise(
        readAppCommandCacheForCwdDetailed(options).pipe(Effect.provideService(HostExecutionDefaults, host)),
      ),
    ).toMatchObject({ status: "fresh" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reused command entries record the new load's environment dependencies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-index-reused-environment-"));
  const document = landofile({ _tag: "Names", names: ["A"] });
  const options = { cwd, cacheRoot: join(cwd, "cache"), landofile: document, entries: [] };
  const env = { A: "stable", B: "before" };
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: environment\n");
    await Effect.runPromise(writeAppCommandCacheStrict({ ...options, env, now: () => 1 }));
    rememberLandofileEnvironmentDependencies(document, { _tag: "Names", names: ["B"] });
    await Effect.runPromise(writeAppCommandCacheStrict({ ...options, env, now: () => 2 }));
    const reused = await Effect.runPromise(readAppCommandCacheForCwdDetailed({ ...options, env }));
    expect(reused).toMatchObject({
      status: "fresh",
      payload: { generatedAtMs: 1, sourceEnvironment: { _tag: "Names", names: ["B"] } },
    });
    const changed = await Effect.runPromise(
      readAppCommandCacheForCwdDetailed({
        ...options,
        env: { ...env, B: "after" },
      }),
    );
    expect(changed).toMatchObject({ status: "stale", staleReason: "environment" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
