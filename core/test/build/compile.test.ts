import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";
import { resolveCompiledBinaryVersion } from "../../../scripts/compiled-binary-version.ts";
import corePackage from "../../package.json";
import { providerImages } from "../../src/testing/engine-layers.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryPath = resolve(coreRoot, "dist/lando");
const expectedBundledPluginNames: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/service-lando",
  "@lando/file-sync-mutagen",
  "@lando/proxy-traefik",
];

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const decodeEnvelope = (output: string): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(output));

const runCommand = async (cmd: Array<string>, options: RunCommandOptions = {}): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd ?? coreRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
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
      "bun run ../scripts/build-compiled-binary.ts --outfile ./dist/lando --minify --sourcemap=external",
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
    expect(binaryText).toContain("built-in-command-registry");
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
    expect(version.stdout.trim()).toBe(resolveCompiledBinaryVersion({ cwd: resolve(coreRoot, "..") }));
    expect(version.stdout.trim()).not.toBe(corePackage.version);
    expect(version.stderr).toBe("");

    const help = await runCommand([binaryPath, "--help"]);
    expect(help.exitCode).toBe(0);
    // Native registry help must render the curated map. A silent exit-0
    // means the compiled entry never reached the dispatcher, which also guards
    // the canonical `bin/lando.ts` compile entry.
    expect(help.stdout).toContain("USAGE");
    expect(help.stdout).toContain("COMMON");
    expect(help.stdout).toContain("MORE");
    expect(help.stderr).not.toContain("could not find package.json");

    const relocatedRoot = await mkdtemp(resolve(tmpdir(), "lando-opentui-compiled-"));
    const relocatedBinary = resolve(relocatedRoot, "lando");
    const appRoot = resolve(relocatedRoot, "app");
    await copyFile(binaryPath, relocatedBinary);
    await mkdir(appRoot);
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: resolve(relocatedRoot, "config"),
      LANDO_USER_DATA_ROOT: resolve(relocatedRoot, "data"),
      LANDO_USER_CACHE_ROOT: resolve(relocatedRoot, "cache"),
      TERM: "xterm-256color",
    };
    Reflect.deleteProperty(env, "CI");
    const relocatedHelp = await runCommand([relocatedBinary, "--help"], {
      cwd: appRoot,
      env,
    });
    expect(relocatedHelp.exitCode).toBe(0);
    expect(relocatedHelp.stdout).toContain("USAGE");
    expect(relocatedHelp.stdout).toContain("COMMON");
    expect(relocatedHelp.stdout).toContain("MORE");
    expect(relocatedHelp.stderr).toBe("");
    const versionJson = await runCommand([relocatedBinary, "meta:version", "--format=json"], {
      cwd: appRoot,
      env,
    });
    const versionEnvelope = decodeEnvelope(versionJson.stdout);
    expect(versionJson.exitCode).toBe(0);
    expect(versionJson.stderr).toBe("");
    expect(versionEnvelope).toMatchObject({
      apiVersion: "v4",
      command: "meta:version",
      ok: true,
      result: { core: expect.any(String) },
    });

    const deferredJson = await runCommand([relocatedBinary, "meta:events:follow", "--format=json"], {
      cwd: appRoot,
      env,
    });
    const deferredEnvelope = decodeEnvelope(deferredJson.stdout);
    expect(deferredJson.exitCode).toBe(1);
    expect(deferredJson.stderr).toBe("");
    expect(deferredEnvelope).toMatchObject({
      apiVersion: "v4",
      command: "meta:events:follow",
      ok: false,
      error: { _tag: "NotImplementedError" },
    });

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
