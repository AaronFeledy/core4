import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";
import { providerImages } from "../../src/data-mover/generated/provider-images.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryPath = resolve(coreRoot, "dist/lando");
const expectedBundledPluginNames: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/service-lando",
  "@lando/logger-pretty",
  "@lando/file-sync-mutagen",
  "@lando/proxy-traefik",
];

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: Array<string>, cwd = coreRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe("compiled binary build command", () => {
  test("uses bytecode for the canonical compiled entry", () => {
    expect(corePackage.scripts["build:compile"]).toContain(
      "bun run ../scripts/build-compiled-binary.ts --outfile ./dist/lando",
    );
    expect(corePackage.scripts["build:compile"]).toContain("bun run ../scripts/sanitize-compiled-binary.ts");
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled Linux x64 binary", () => {
  test("builds an executable lando binary with version and help fast paths", async () => {
    const build = await runCommand([process.execPath, "run", "build"]);
    expect(build.exitCode).toBe(0);

    const binary = await stat(binaryPath);
    expect(binary.isFile()).toBe(true);
    expect(binary.mode & 0o111).not.toBe(0);
    const binaryText = await Bun.file(binaryPath).text();
    expect(binaryText).not.toContain(".tsbuildinfo");
    const embeddedOpenTuiAssets = new Set(
      binaryText.match(/\/\$bunfs\/root\/libopentui-[a-z0-9]+\.so/gu) ?? [],
    );
    expect([...embeddedOpenTuiAssets]).toHaveLength(1);
    expect(await Bun.file(resolve(coreRoot, "dist/libopentui.so")).exists()).toBe(false);
    expect(await Bun.file(resolve(coreRoot, "dist/node_modules")).exists()).toBe(false);
    for (const pluginName of expectedBundledPluginNames) {
      expect(binaryText).toContain(pluginName);
    }
    const dataHelper = providerImages.images.dataHelper;
    expect(binaryText).toContain(dataHelper.image);
    expect(binaryText).toContain(dataHelper.digest);

    const version = await runCommand([binaryPath, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(corePackage.version);
    expect(version.stderr).toBe("");

    const help = await runCommand([binaryPath, "--help"]);
    expect(help.exitCode).toBe(0);
    // OCLIF help must actually register commands and topics — a silent exit-0
    // means the binary skipped OCLIF entirely (regression guard for the
    // compile entry-point: must be `bin/lando.ts`, not `src/cli/index.ts`).
    expect(help.stdout).toContain("USAGE");
    expect(help.stdout).toContain("TOPICS");
    expect(help.stdout).toContain("COMMANDS");
    expect(help.stderr).not.toContain("could not find package.json");

    const relocatedRoot = await mkdtemp(resolve(tmpdir(), "lando-opentui-compiled-"));
    const relocatedBinary = resolve(relocatedRoot, "lando");
    const appRoot = resolve(relocatedRoot, "app");
    await copyFile(binaryPath, relocatedBinary);
    await mkdir(appRoot);
    const env = {
      ...process.env,
      LANDO_USER_DATA_ROOT: resolve(relocatedRoot, "data"),
      LANDO_USER_CACHE_ROOT: resolve(relocatedRoot, "cache"),
      TERM: "xterm-256color",
    };
    Reflect.deleteProperty(env, "CI");
    let ptyOutput = "";
    const prompt = Bun.spawn({
      cmd: [relocatedBinary, "init"],
      cwd: appRoot,
      env,
      terminal: {
        cols: 100,
        rows: 30,
        data: (_terminal, data) => {
          ptyOutput += new TextDecoder().decode(data);
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (ptyOutput.includes("Pick a recipe")) break;
        await Bun.sleep(20);
      }
      expect(ptyOutput).toContain("Pick a recipe");
      expect(ptyOutput).toContain("╭");
    } finally {
      prompt.kill("SIGINT");
      await prompt.exited;
      prompt.terminal?.close();
      await rm(relocatedRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
