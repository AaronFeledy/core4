// allow: SIZE_OK — cross-platform compiled-binary PTY acceptance is one release-artifact scenario.
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { opentuiNativeCatalog } from "../../../scripts/generated/opentui-native/catalog.generated.ts";

const binaryPath = process.env.LANDO_OPENTUI_ACCEPTANCE_BINARY;
const releaseTarget = process.env.LANDO_RELEASE_TARGET;
const enabled = binaryPath !== undefined && releaseTarget !== undefined;
const repoRoot = resolve(import.meta.dirname, "../../..");
const probePreload = resolve(import.meta.dirname, "fixtures/opentui-loader-probe-preload.ts");

interface LoaderProbeEvent {
  readonly phase: "attempt" | "ready";
  readonly specifier: "@opentui/core";
  readonly nativeRoot?: string;
}

const cleanEnv = (root: string): NodeJS.ProcessEnv => {
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

const probeEnv = (env: NodeJS.ProcessEnv, tracePath: string, fail = false): NodeJS.ProcessEnv => ({
  ...env,
  BUN_OPTIONS: `--preload=${probePreload}`,
  LANDO_OPENTUI_PROBE_TRACE: tracePath,
  ...(fail ? { LANDO_OPENTUI_PROBE_FAIL: "1" } : {}),
});

const readProbe = async (tracePath: string): Promise<ReadonlyArray<LoaderProbeEvent>> => {
  const file = Bun.file(tracePath);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoaderProbeEvent);
};

const nativeAssetPattern = (target: string): RegExp => {
  if (target.startsWith("darwin-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.dylib/gu;
  if (target.startsWith("linux-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.so/gu;
  if (target === "windows-x64") return /B:\/~BUN\/root\/opentui-[a-z0-9]+\.dll/gu;
  throw new Error(`Unsupported OpenTUI acceptance target: ${target}.`);
};

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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

const expectNonLoadingDispatches = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  for (const args of [["--version"], ["--help"], ["init"], ["init", "--renderer=json"]]) {
    const normal = await runNonTty(command, cwd, args, env);
    const withoutOpenTui = await runNonTty(command, cwd, args, {
      ...env,
      LANDO_NO_OPENTUI_PROMPTS: "1",
    });
    expect(normal).toEqual(withoutOpenTui);
    expect(`${normal.stdout}${normal.stderr}`).not.toContain("╭");
  }
};

/** Drop intermittent winpty/libwinpty abort noise and blank-line padding from PTY capture. */
const scrubPtyNoise = (text: string): string => {
  const csi = `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`;
  return text
    .replace(/Assertion failed:[\s\S]*?(?:\r?\n|$)/g, "")
    .replace(new RegExp(csi, "g"), "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
};

const terminateWindowsProcessTree = async (pid: number): Promise<void> => {
  const taskkill = Bun.spawn({
    cmd: ["taskkill.exe", "/PID", String(pid), "/T", "/F"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    taskkill.exited,
    new Response(taskkill.stdout).text(),
    new Response(taskkill.stderr).text(),
  ]);
  const detail = `${stderr}${stdout}`;
  // 0 = killed; 128 = process already gone (classic). Windows also returns 255 with
  // "There is no running instance of the task." when the tree races to exit first.
  const alreadyGone =
    exitCode === 128 || (exitCode === 255 && /no running instance of the task/i.test(detail));
  if (exitCode !== 0 && !alreadyGone) {
    throw new Error(
      `Failed to terminate Windows PTY process tree ${String(pid)} (exit ${String(exitCode)}): ${detail}`,
    );
  }
};

const removeRelocatedBinaryRoot = async (root: string): Promise<void> => {
  const retryableCodes = new Set(["EACCES", "EBUSY", "ENOTEMPTY"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (process.platform !== "win32" || typeof code !== "string" || !retryableCodes.has(code)) throw cause;
      if (attempt === 19) {
        console.warn(`Unable to remove relocated Windows acceptance binary after retries: ${String(cause)}`);
        return;
      }
      await Bun.sleep(250);
    }
  }
};

const runPrompt = async (
  command: ReadonlyArray<string>,
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  let output = "";
  if (process.platform === "win32") {
    const winpty = resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/winpty.exe");
    if (!(await Bun.file(winpty).exists())) throw new Error(`Missing Git for Windows PTY helper: ${winpty}`);
    const proc = Bun.spawn({
      cmd: [winpty, "-Xallow-non-tty", ...command, ...args],
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const consumeOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      let text = "";
      for await (const chunk of stream) {
        const decoded = new TextDecoder().decode(chunk);
        text += decoded;
        output += decoded;
      }
      return text;
    };
    const stdout = consumeOutput(proc.stdout);
    const stderr = consumeOutput(proc.stderr);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (output.includes("╭") || output.includes("(value or index):")) break;
      await Bun.sleep(20);
    }
    try {
      await terminateWindowsProcessTree(proc.pid);
    } catch (cause) {
      proc.kill();
      await proc.exited;
      throw cause;
    }
    await proc.exited;
    output = `${await stdout}${await stderr}`;
  } else {
    const proc = Bun.spawn({
      cmd: [...command, ...args],
      cwd,
      env,
      terminal: {
        cols: 100,
        rows: 30,
        data: (_terminal, data) => {
          output += new TextDecoder().decode(data);
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (output.includes("╭") || output.includes("(value or index):")) break;
        await Bun.sleep(20);
      }
    } finally {
      proc.terminal?.close();
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
  return output.replaceAll("\r\n", "\n");
};

describe.skipIf(!enabled)("compiled OpenTUI release-target acceptance", () => {
  test("embeds one native asset and drives only the default renderer through a relocated PTY", async () => {
    const target = releaseTarget as string;
    const sourceBinary = resolve(binaryPath as string);
    const binaryText = await Bun.file(sourceBinary).text();
    const embeddedAssets = new Set(binaryText.match(nativeAssetPattern(target)) ?? []);
    const selectedRoot =
      opentuiNativeCatalog.targetToNativeRoot[target as keyof typeof opentuiNativeCatalog.targetToNativeRoot];
    if (selectedRoot === undefined) throw new Error(`Missing native-root mapping for ${target}.`);
    expect([...embeddedAssets]).toHaveLength(1);
    expect(binaryText).toContain(selectedRoot);

    const adjacent = await readdir(dirname(sourceBinary));
    expect(adjacent.some((entry) => [".so", ".dylib", ".dll"].includes(extname(entry)))).toBe(false);
    expect(adjacent).not.toContain("node_modules");

    const root = await mkdtemp(resolve(tmpdir(), `lando-opentui-${target}-`));
    const binaryRoot = await mkdtemp(resolve(tmpdir(), `lando-opentui-binary-${target}-`));
    const relocatedBinary = resolve(binaryRoot, process.platform === "win32" ? "lando.exe" : "lando");
    const appRoot = resolve(root, "app");
    await copyFile(sourceBinary, relocatedBinary);
    await mkdir(appRoot);
    const baseEnv = cleanEnv(root);
    try {
      const bypassTrace = resolve(root, "bypass.jsonl");
      await expectNonLoadingDispatches([relocatedBinary], appRoot, probeEnv(baseEnv, bypassTrace));
      expect(await readProbe(bypassTrace)).toEqual([]);

      const richTrace = resolve(root, "rich.jsonl");
      const rich = await runPrompt([relocatedBinary], appRoot, ["init"], probeEnv(baseEnv, richTrace));
      expect(rich).toContain("Pick a recipe");
      expect(rich).toContain("╭");
      expect(await readProbe(richTrace)).toEqual([
        { phase: "attempt", specifier: "@opentui/core" },
        { phase: "ready", specifier: "@opentui/core", nativeRoot: selectedRoot },
      ]);

      for (const renderer of ["plain", "json"] as const) {
        const tracePath = resolve(root, `${renderer}.jsonl`);
        const normal = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          probeEnv(baseEnv, tracePath),
        );
        const withoutOpenTui = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          { ...baseEnv, LANDO_NO_OPENTUI_PROMPTS: "1" },
        );
        expect(scrubPtyNoise(normal)).not.toContain("╭");
        expect(scrubPtyNoise(normal)).toContain("(value or index):");
        expect(scrubPtyNoise(normal)).toBe(scrubPtyNoise(withoutOpenTui));
        expect(await readProbe(tracePath)).toEqual([]);
      }

      const failureTrace = resolve(root, "failure.jsonl");
      const degraded = await runPrompt(
        [relocatedBinary],
        appRoot,
        ["init"],
        probeEnv(baseEnv, failureTrace, true),
      );
      expect(degraded).toContain("(value or index):");
      expect(await readProbe(failureTrace)).toEqual([{ phase: "attempt", specifier: "@opentui/core" }]);
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        await removeRelocatedBinaryRoot(binaryRoot);
      }
    }
  }, 120_000);
});

describe.skipIf(process.platform === "win32")("source OpenTUI renderer-mode acceptance", () => {
  test("plain and json are byte-identical to the explicit line-mode baseline", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "lando-opentui-source-"));
    const appRoot = resolve(root, "app");
    await mkdir(appRoot);
    const baseEnv = cleanEnv(root);
    const command = [process.execPath, resolve(repoRoot, "core/bin/lando.ts")];
    try {
      const bypassTrace = resolve(root, "bypass.jsonl");
      await expectNonLoadingDispatches(command, appRoot, probeEnv(baseEnv, bypassTrace));
      expect(await readProbe(bypassTrace)).toEqual([]);
      const richTrace = resolve(root, "rich.jsonl");
      const rich = await runPrompt(command, appRoot, ["init"], probeEnv(baseEnv, richTrace));
      expect(rich).toContain("╭");
      expect(await readProbe(richTrace)).toEqual([
        { phase: "attempt", specifier: "@opentui/core" },
        { phase: "ready", specifier: "@opentui/core" },
      ]);
      for (const renderer of ["plain", "json"] as const) {
        const tracePath = resolve(root, `${renderer}.jsonl`);
        const normal = await runPrompt(
          command,
          appRoot,
          ["init", `--renderer=${renderer}`],
          probeEnv(baseEnv, tracePath),
        );
        const withoutOpenTui = await runPrompt(command, appRoot, ["init", `--renderer=${renderer}`], {
          ...baseEnv,
          LANDO_NO_OPENTUI_PROMPTS: "1",
        });
        expect(scrubPtyNoise(normal)).not.toContain("╭");
        expect(scrubPtyNoise(normal)).toContain("(value or index):");
        expect(scrubPtyNoise(normal)).toBe(scrubPtyNoise(withoutOpenTui));
        expect(await readProbe(tracePath)).toEqual([]);
      }
      const failureTrace = resolve(root, "failure.jsonl");
      const degraded = await runPrompt(command, appRoot, ["init"], probeEnv(baseEnv, failureTrace, true));
      expect(degraded).toContain("(value or index):");
      expect(await readProbe(failureTrace)).toEqual([{ phase: "attempt", specifier: "@opentui/core" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
