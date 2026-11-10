import { realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";

import { expect } from "bun:test";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";

import { InitAppResultSchema } from "../../../src/cli/commands/recipe-init-schemas.ts";
import { removeAcceptanceRoot, withAcceptanceCleanup } from "./opentui-acceptance-cleanup.ts";

export const repoRoot = resolve(import.meta.dirname, "../../../..");
const probePreload = resolve(import.meta.dirname, "opentui-loader-probe-preload.ts");

interface LoaderProbeEvent {
  readonly phase: "attempt" | "ready";
  readonly specifier: "@opentui/core";
  readonly nativeRoot?: string;
}

export const cleanEnv = (root: string): NodeJS.ProcessEnv => {
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: resolve(root, "data"),
    LANDO_USER_CACHE_ROOT: resolve(root, "cache"),
    LANDO_USER_CONF_ROOT: resolve(root, "config"),
    TERM: "xterm-256color",
  };
  for (const key of Object.keys(env)) {
    if (key === "CI" || key === "LANDO_RENDERER" || key === "LANDO_NO_OPENTUI_PROMPTS") {
      Reflect.deleteProperty(env, key);
    }
    if (key === "BUN_OPTIONS" || key.startsWith("LANDO_CONFIG__")) Reflect.deleteProperty(env, key);
  }
  return env;
};

export const probeEnv = (env: NodeJS.ProcessEnv, tracePath: string, fail = false): NodeJS.ProcessEnv => ({
  ...env,
  BUN_OPTIONS: `--preload=${probePreload}`,
  LANDO_OPENTUI_PROBE_TRACE: tracePath,
  ...(fail ? { LANDO_OPENTUI_PROBE_FAIL: "1" } : {}),
});

export const readProbe = async (tracePath: string): Promise<ReadonlyArray<LoaderProbeEvent>> => {
  const file = Bun.file(tracePath);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoaderProbeEvent);
};

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const normalizeTiming = (text: string): string =>
  text
    .replace(/\(\d+(?:\.\d+)?(?:ms|s)\)/g, "(<elapsed>)")
    .replace(/"durationMs":\s*\d+(?:\.\d+)?/g, '"durationMs":0')
    .replace(/("receipt":\s*\{\s*"id":\s*")[0-9a-f-]+"/g, '$1<transaction-id>"')
    // Recipe notices are renderer events; independent runs retain different clock instants.
    .replace(/"timestamp":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"timestamp":"<timestamp>"');

const normalizeRunElapsedTiming = (result: RunResult): RunResult => ({
  ...result,
  stdout: normalizeTiming(result.stdout),
  stderr: normalizeTiming(result.stderr),
});

const runNonTty = async (
  command: ReadonlyArray<string>,
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...command, ...args],
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const expectNonLoadingDispatches = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  for (const args of [["--version"], ["--help"], ["init"], ["init", "--renderer=json"]]) {
    const dest = await mkdtemp(resolve(cwd, "dispatch-"));
    await withAcceptanceCleanup([dest], async () => {
      const normal = await runNonTty(command, dest, args, env);
      await removeAcceptanceRoot(dest);
      await mkdir(dest);
      const withoutOpenTui = await runNonTty(command, dest, args, {
        ...env,
        LANDO_NO_OPENTUI_PROMPTS: "1",
      });
      expect(normalizeRunElapsedTiming(normal)).toEqual(normalizeRunElapsedTiming(withoutOpenTui));
      expect(`${normal.stdout}${normal.stderr}`).not.toContain("╭");
    });
  }
};

/** Drop intermittent winpty/libwinpty abort noise and blank-line padding from PTY capture. */
export const scrubPtyNoise = (text: string): string => {
  const csi = `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`;
  return text
    .replace(/Assertion failed:[\s\S]*?(?:\r?\n|$)/g, "")
    .replace(new RegExp(csi, "g"), "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
};

/**
 * Decode NDJSON captured through a PTY. Git for Windows' winpty scrapes a fixed-width
 * console and splits long records across rows, so rows are joined until they parse.
 */
const parseCapturedNdjson = (output: string): readonly unknown[] => {
  const values: unknown[] = [];
  let pending = "";
  for (const row of scrubPtyNoise(output).split("\n")) {
    pending += row;
    try {
      values.push(JSON.parse(pending));
      pending = "";
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  if (pending !== "") throw new Error(`PTY capture is not NDJSON after joining wrapped rows:\n${output}`);
  return values;
};

/** Compare machine records rather than PTY row layout, which wraps at the console width on Windows. */
export const capturedTranscript = (output: string, renderer: "plain" | "json"): string =>
  renderer === "json"
    ? parseCapturedNdjson(output)
        .map((value) => JSON.stringify(value))
        .join("\n")
    : scrubPtyNoise(output);

export const expectMachineInit = (output: string, cwd: string): void => {
  const values = parseCapturedNdjson(output);
  const envelopes = values.filter(Schema.is(CommandResultEnvelope));
  expect(envelopes).toHaveLength(1);
  const envelope = envelopes[0];
  expect(envelope).toMatchObject({ command: "apps:init", ok: true });
  const result = Schema.decodeUnknownSync(InitAppResultSchema)(envelope?.result, {
    onExcessProperty: "error",
  });
  // Init reports the canonical app root; macOS temp roots sit under the /var -> /private/var symlink.
  expect(realpathSync(result.directory)).toBe(realpathSync(cwd));
  expect(result.receipt.created.map(({ path }) => path).sort()).toEqual([
    ".lando.yml",
    "package.json",
    "server.js",
  ]);
};
