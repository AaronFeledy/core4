import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  readAppCommandCache,
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { HostExecutionDefaults } from "../../src/services/host-execution-context.ts";

test.each([
  { before: { A: "one", B: "two" }, after: { B: "two", A: "one" }, fresh: true },
  { before: { A: "one" }, after: { A: "two" }, fresh: false },
  { before: {}, after: { A: "" }, fresh: false },
  { before: { A: "" }, after: {}, fresh: false },
  { before: { A: undefined }, after: { A: "" }, fresh: false },
  { before: { A: undefined }, after: {}, fresh: false },
])("compares captured environment inputs independently of ordering %#", async ({ before, after, fresh }) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-index-environment-"));
  const options = { cwd, cacheRoot: join(cwd, "cache"), landofile: { name: "environment" }, entries: [] };
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
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("engine cache defaults inherit a captured host environment before ambient defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-index-host-environment-"));
  const options = { cwd, cacheRoot: join(cwd, "cache"), landofile: { name: "captured" }, entries: [] };
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
