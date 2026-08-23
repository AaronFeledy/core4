import { afterEach, beforeEach } from "bun:test";
import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Schema } from "effect";

import {
  ScratchListResultSchema,
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
  Effect.runPromise(effect.pipe(Effect.provide(scratchRuntime())) as Effect.Effect<A, E, never>);

const failureTag = async <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<string> => {
  const result = await Effect.runPromise(
    effect.pipe(Effect.provide(scratchRuntime()), Effect.either) as unknown as Effect.Effect<
      { readonly _tag: "Left"; readonly left: E } | { readonly _tag: "Right"; readonly right: A },
      never,
      never
    >,
  );
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
    expect(Schema.encodeSync(ScratchListResultSchema)(result)).toEqual([]);
    expect(renderScratchListResult(result, "table")).toBe("No scratch apps found.");
  });

  test("gc reports the current empty orphan-reap result", async () => {
    const result = await runScratch(scratchGc({ prune: true }));
    expect(result).toEqual({ inspected: 0, reaped: [], errors: [] });
    expect(renderScratchGcReport(result)).toBe("inspected: 0\nreaped: 0\nerrors: 0");
  });

  test("id-addressed operations return ScratchAppNotFoundError for unknown ids", async () => {
    const id = "scratch-nope-000000";
    await expect(failureTag(scratchInfo(id))).resolves.toBe("ScratchAppNotFoundError");
    await expect(failureTag(scratchLogs(id))).resolves.toBe("ScratchAppNotFoundError");
    await expect(failureTag(scratchStop(id))).resolves.toBe("ScratchAppNotFoundError");
    await expect(failureTag(scratchDestroy(id))).resolves.toBe("ScratchAppNotFoundError");
  });
});

describe("apps:scratch:* source CLI routing", () => {
  test("scratch list canonical and alias routes render the empty list", async () => {
    for (const args of [
      ["apps:scratch:list", "--format", "json"],
      ["scratch:list", "--format", "json"],
      ["scratch", "list", "--format", "json"],
    ] as const) {
      const result = await runSource([...args]);
      expect(result.exitCode, args.join(" ")).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        readonly ok?: boolean;
        readonly command?: string;
        readonly result?: unknown;
      };
      expect(envelope.ok, args.join(" ")).toBe(true);
      expect(envelope.command, args.join(" ")).toBe("apps:scratch:list");
      expect(envelope.result, args.join(" ")).toEqual([]);
    }
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

  test("space, colon-alias, and canonical scratch verbs share command identity", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly argSets: ReadonlyArray<ReadonlyArray<string>>;
      readonly assert: (result: RunResult, label: string) => void;
    }> = [
      {
        label: "start",
        argSets: [
          ["apps:scratch:start", "--detach"],
          ["scratch:start", "--detach"],
          ["scratch", "start", "--detach"],
        ],
        assert: (result, label) => {
          expect(result.stderr, label).toContain("commandId: apps:scratch:start");
          expect(result.stderr, label).not.toContain("InvalidCliInvocationError");
          expect(result.stderr, label).not.toContain("Unexpected argument");
        },
      },
      {
        label: "stop",
        argSets: [
          ["apps:scratch:stop", "x"],
          ["scratch:stop", "x"],
          ["scratch", "stop", "x"],
        ],
        assert: (result, label) => {
          expect(result.stderr, label).toContain("commandId: apps:scratch:stop");
          expect(result.stderr, label).toContain("ScratchAppNotFoundError");
        },
      },
      {
        label: "destroy",
        argSets: [
          ["apps:scratch:destroy", "x"],
          ["scratch:destroy", "x"],
          ["scratch", "destroy", "x"],
        ],
        assert: (result, label) => {
          expect(result.stderr, label).toContain("commandId: apps:scratch:destroy");
          expect(result.stderr, label).toContain("ScratchAppNotFoundError");
        },
      },
      {
        label: "info",
        argSets: [
          ["apps:scratch:info", "nonexistent"],
          ["scratch:info", "nonexistent"],
          ["scratch", "info", "nonexistent"],
        ],
        assert: (result, label) => {
          expect(result.stderr, label).toContain("commandId: apps:scratch:info");
          expect(result.stderr, label).toContain("ScratchAppNotFoundError");
        },
      },
      {
        label: "logs",
        argSets: [
          ["apps:scratch:logs", "nonexistent"],
          ["scratch:logs", "nonexistent"],
          ["scratch", "logs", "nonexistent"],
        ],
        assert: (result, label) => {
          expect(result.stderr, label).toContain("commandId: apps:scratch:logs");
          expect(result.stderr, label).toContain("ScratchAppNotFoundError");
        },
      },
      {
        label: "gc",
        argSets: [
          ["apps:scratch:gc", "--format", "json"],
          ["scratch:gc", "--format", "json"],
          ["scratch", "gc", "--format", "json"],
        ],
        assert: (result, label) => {
          const envelope = JSON.parse(result.stdout) as { readonly command?: string };
          expect(envelope.command, label).toBe("apps:scratch:gc");
        },
      },
      {
        label: "run",
        argSets: [
          ["apps:scratch:run", "--format", "json"],
          ["scratch:run", "--format", "json"],
          ["scratch", "run", "--format", "json"],
        ],
        assert: (result, label) => {
          const jsonLine = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("{"))
            .at(-1);
          expect(jsonLine, label).toBeDefined();
          if (jsonLine === undefined) {
            throw new Error(`${label}: expected JSON line`);
          }
          const parsed = JSON.parse(jsonLine) as {
            readonly command?: string;
            readonly envelope?: { readonly command?: string };
          };
          const command = parsed.command ?? parsed.envelope?.command;
          expect(command, label).toBe("apps:scratch:run");
          expect(result.stderr, label).not.toContain("commandId: apps:scratch:start");
          expect(result.stderr, label).not.toContain("Unexpected argument");
        },
      },
    ];

    for (const { label, argSets, assert } of cases) {
      for (const args of argSets) {
        const result = await runSource([...args]);
        assert(result, `${label}: ${args.join(" ")}`);
      }
    }
  }, 60_000);
});
