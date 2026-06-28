import { afterEach, beforeEach } from "bun:test";
import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";

import {
  renderScratchGcReport,
  renderScratchListResult,
  scratchDestroy,
  scratchGc,
  scratchInfo,
  scratchList,
  scratchLogs,
  scratchStart,
  scratchStop,
} from "../../src/cli/commands/scratch.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const parseEnvelopeResult = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

let cacheRoot = "";
let dataRoot = "";
let confRoot = "";
let previousCacheRoot: string | undefined;
let previousDataRoot: string | undefined;
let previousConfRoot: string | undefined;

beforeEach(async () => {
  cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-cli-cache-")));
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-cli-data-")));
  confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-cli-conf-")));
  previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  previousConfRoot = process.env.LANDO_USER_CONF_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  process.env.LANDO_USER_DATA_ROOT = dataRoot;
  process.env.LANDO_USER_CONF_ROOT = confRoot;
});

afterEach(async () => {
  if (previousCacheRoot === undefined) {
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    delete process.env.LANDO_USER_CACHE_ROOT;
  } else {
    process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
  }
  if (previousDataRoot === undefined) {
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    delete process.env.LANDO_USER_DATA_ROOT;
  } else {
    process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
  }
  if (previousConfRoot === undefined) {
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    delete process.env.LANDO_USER_CONF_ROOT;
  } else {
    process.env.LANDO_USER_CONF_ROOT = previousConfRoot;
  }
  await rm(cacheRoot, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
  await rm(confRoot, { recursive: true, force: true });
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runSource = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: dataRoot,
      LANDO_USER_CONF_ROOT: confRoot,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const scratchRuntime = () => makeLandoRuntime({ bootstrap: "scratch" });

const runScratch = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(scratchRuntime())));

const failureTag = async <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<string> => {
  const result = await Effect.runPromise(effect.pipe(Effect.provide(scratchRuntime()), Effect.either));
  expect(result._tag).toBe("Left");
  if (result._tag === "Right") throw new Error("expected scratch operation to fail");
  return (result.left as { readonly _tag?: string })._tag ?? "";
};

describe("apps:scratch:* command operations", () => {
  test("start accepts detach and returns the current source resolver error", async () => {
    await expect(failureTag(scratchStart({}))).resolves.toBe("ScratchSourceUnresolvedError");
    await expect(failureTag(scratchStart({ detach: true }))).resolves.toBe("ScratchSourceUnresolvedError");
  });

  test("list renders an honest empty scratch list", async () => {
    const result = await runScratch(scratchList());
    expect(result).toEqual([]);
    expect(renderScratchListResult(result, "json")).toBe("[]");
    expect(renderScratchListResult(result, "table")).toBe("No scratch apps found.");
  });

  test("gc reports the current empty orphan-reap result", async () => {
    const result = await runScratch(scratchGc({ prune: true }));
    expect(result).toEqual({ inspected: 0, reaped: [], errors: [] });
    expect(renderScratchGcReport(result)).toBe("inspected: 0\nreaped: 0\nerrors: 0");
  });

  test("id-addressed operations return ScratchAppNotFoundError for unknown ids", async () => {
    const id = "scratch-nope-000000";
    for (const operation of [scratchInfo(id), scratchLogs(id), scratchStop(id), scratchDestroy(id)]) {
      await expect(failureTag(operation)).resolves.toBe("ScratchAppNotFoundError");
    }
  });
});

describe("apps:scratch:* source CLI routing", () => {
  test("scratch list canonical and alias routes render the empty list", async () => {
    const canonical = await runSource(["apps:scratch:list", "--format", "json"]);
    const alias = await runSource(["scratch:list", "--format", "json"]);
    expect(canonical.exitCode).toBe(0);
    expect(parseEnvelopeResult<ReadonlyArray<unknown>>(canonical.stdout)).toEqual([]);
    expect(alias.exitCode).toBe(canonical.exitCode);
    expect(parseEnvelopeResult<ReadonlyArray<unknown>>(alias.stdout)).toEqual([]);
  }, 30_000);

  test("scratch gc alias routes to the real orphan-reap seam", async () => {
    const result = await runSource(["scratch:gc"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("inspected: 0\nreaped: 0\nerrors: 0\n");
  }, 30_000);

  test("scratch start accepts --detach and returns the current source resolver error", async () => {
    for (const command of ["apps:scratch:start", "scratch:start", "scratch"] as const) {
      const result = await runSource([command, "--detach"]);
      expect(result.exitCode, command).not.toBe(0);
      expect(result.stderr, command).toContain("ScratchSourceUnresolvedError");
      expect(result.stderr, command).toContain("commandId: apps:scratch:start");
      expect(result.stderr, command).not.toContain('{"source"');
    }
  }, 30_000);

  test("id-addressed routes return clean unknown-id errors", async () => {
    for (const [command, id] of [
      ["apps:scratch:info", "nonexistent"],
      ["apps:scratch:logs", "nonexistent"],
      ["apps:scratch:stop", "x"],
      ["apps:scratch:destroy", "x"],
    ] as const) {
      const result = await runSource([command, id]);
      expect(result.exitCode, command).not.toBe(0);
      expect(result.stderr, command).toContain("ScratchAppNotFoundError");
      expect(result.stderr, command).toContain(`commandId: ${command}`);
      expect(result.stderr, command).toContain(id);
      expect(result.stderr, command).not.toContain('{"id"');
    }
  }, 30_000);
});
