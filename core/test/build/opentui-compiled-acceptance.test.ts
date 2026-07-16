import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { opentuiNativeCatalog } from "../../../scripts/generated/opentui-native/catalog.generated.ts";

const binaryPath = process.env.LANDO_OPENTUI_ACCEPTANCE_BINARY;
const releaseTarget = process.env.LANDO_RELEASE_TARGET;
const enabled = binaryPath !== undefined && releaseTarget !== undefined;
const repoRoot = resolve(import.meta.dirname, "../../..");

const nativeAssetPattern = (target: string): RegExp => {
  if (target.startsWith("darwin-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.dylib/gu;
  if (target.startsWith("linux-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.so/gu;
  if (target === "windows-x64") return /B:\/~BUN\/root\/opentui-[a-z0-9]+\.dll/gu;
  throw new Error(`Unsupported OpenTUI acceptance target: ${target}.`);
};

const promptPrefix = (output: string): string => {
  const marker = "(value or index):";
  const end = output.indexOf(marker);
  return end === -1 ? output : output.slice(0, end + marker.length);
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
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    await Bun.sleep(3_000);
    proc.stdin.write("\x03");
    await proc.stdin.end();
    const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => undefined)]);
    if (exited === undefined) proc.kill();
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
      proc.kill("SIGINT");
      await proc.exited;
      proc.terminal?.close();
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
    const relocatedBinary = resolve(root, process.platform === "win32" ? "lando.exe" : "lando");
    const appRoot = resolve(root, "app");
    await copyFile(sourceBinary, relocatedBinary);
    await mkdir(appRoot);
    const baseEnv = {
      ...process.env,
      LANDO_USER_DATA_ROOT: resolve(root, "data"),
      LANDO_USER_CACHE_ROOT: resolve(root, "cache"),
      TERM: "xterm-256color",
    };
    Reflect.deleteProperty(baseEnv, "CI");
    try {
      const rich = await runPrompt([relocatedBinary], appRoot, ["init"], baseEnv);
      expect(rich).toContain("Pick a recipe");
      expect(rich).toContain("╭");
      await expectNonLoadingDispatches([relocatedBinary], appRoot, baseEnv);

      for (const renderer of ["plain", "json"] as const) {
        const normal = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          baseEnv,
        );
        const withoutOpenTui = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          { ...baseEnv, LANDO_NO_OPENTUI_PROMPTS: "1" },
        );
        expect(normal).not.toContain("╭");
        expect(normal).toContain("(value or index):");
        expect(promptPrefix(normal)).toBe(promptPrefix(withoutOpenTui));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(process.platform === "win32")("source OpenTUI renderer-mode acceptance", () => {
  test("plain and json are byte-identical to the explicit line-mode baseline", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "lando-opentui-source-"));
    const appRoot = resolve(root, "app");
    await mkdir(appRoot);
    const baseEnv = {
      ...process.env,
      LANDO_USER_DATA_ROOT: resolve(root, "data"),
      LANDO_USER_CACHE_ROOT: resolve(root, "cache"),
      TERM: "xterm-256color",
    };
    Reflect.deleteProperty(baseEnv, "CI");
    const command = [process.execPath, resolve(repoRoot, "core/bin/lando.ts")];
    try {
      await expectNonLoadingDispatches(command, appRoot, baseEnv);
      for (const renderer of ["plain", "json"] as const) {
        const normal = await runPrompt(command, appRoot, ["init", `--renderer=${renderer}`], baseEnv);
        const withoutOpenTui = await runPrompt(command, appRoot, ["init", `--renderer=${renderer}`], {
          ...baseEnv,
          LANDO_NO_OPENTUI_PROMPTS: "1",
        });
        expect(normal).not.toContain("╭");
        expect(normal).toContain("(value or index):");
        expect(promptPrefix(normal)).toBe(promptPrefix(withoutOpenTui));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
