/**
 * Version embedding contract.
 *
 * The reported core version must derive from a single source of truth: the
 * build-time stamped version (injected via `bun build --define`) in compiled
 * and bundled artifacts, falling back to the workspace package version when
 * running from source. A built artifact must never report the `0.0.0`
 * placeholder once a real version is stamped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binaryEntry = resolve(coreRoot, "bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: coreRoot,
    env: { ...process.env },
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

const buildBundle = async (root: string, define?: string): Promise<string> => {
  const bundlePath = join(root, "lando.js");
  const cmd = [process.execPath, "build", binaryEntry, "--outdir", root, "--target", "bun"];
  if (define !== undefined) cmd.push(`--define=${define}`);
  const result = await runCommand(cmd);
  if (result.exitCode !== 0) throw new Error(`Unable to build CLI bundle:\n${result.stderr}`);
  return bundlePath;
};

const STAMPED_VERSION = "9.9.9-embed-test";

describe("version embedding (bundled artifact)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-version-embed-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("embeds the stamped version via --define into the built artifact", async () => {
    const stampedRoot = join(root, "stamped");
    const bundle = await buildBundle(stampedRoot, `__LANDO_CORE_VERSION__="${STAMPED_VERSION}"`);

    const versionOut = await runCommand([process.execPath, bundle, "version"]);
    expect(versionOut.exitCode).toBe(0);
    expect(versionOut.stdout.trim()).toBe(STAMPED_VERSION);

    const flagOut = await runCommand([process.execPath, bundle, "--version"]);
    expect(flagOut.exitCode).toBe(0);
    expect(flagOut.stdout.trim()).toBe(STAMPED_VERSION);
  });

  test("guards against the 0.0.0 placeholder once a real version is stamped", async () => {
    const guardRoot = join(root, "guard");
    const bundle = await buildBundle(guardRoot, `__LANDO_CORE_VERSION__="4.1.0-guard"`);

    const versionOut = await runCommand([process.execPath, bundle, "version"]);
    expect(versionOut.exitCode).toBe(0);
    expect(versionOut.stdout.trim()).not.toBe("0.0.0");
    expect(versionOut.stdout.trim()).toBe("4.1.0-guard");
  });

  test("falls back to the workspace package version when no version is stamped", async () => {
    const fallbackRoot = join(root, "fallback");
    const bundle = await buildBundle(fallbackRoot);

    const versionOut = await runCommand([process.execPath, bundle, "version"]);
    expect(versionOut.exitCode).toBe(0);
    expect(versionOut.stdout.trim()).toBe(corePackage.version);
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "version embedding (compiled binary)",
  () => {
    test("the compiled binary prints the stamped version, never the placeholder", async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-version-compiled-"));
      const outfile = join(root, "lando");
      try {
        const build = await runCommand([
          process.execPath,
          "build",
          binaryEntry,
          "--compile",
          "--bytecode",
          `--define=__LANDO_CORE_VERSION__="8.8.8-stamped"`,
          `--outfile=${outfile}`,
          "--sourcemap=external",
        ]);
        expect(build.exitCode).toBe(0);

        const versionOut = await runCommand([outfile, "version"]);
        expect(versionOut.exitCode).toBe(0);
        expect(versionOut.stdout.trim()).toBe("8.8.8-stamped");
        expect(versionOut.stdout.trim()).not.toBe("0.0.0");

        const flagOut = await runCommand([outfile, "--version"]);
        expect(flagOut.exitCode).toBe(0);
        expect(flagOut.stdout.trim()).toBe("8.8.8-stamped");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
