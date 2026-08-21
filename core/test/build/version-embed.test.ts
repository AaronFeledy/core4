import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import corePackage from "../../package.json";
import { buildCliBundle } from "./cli-bundle.ts";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
    const bundle = await buildCliBundle(stampedRoot, STAMPED_VERSION);

    const versionOut = await runCommand([process.execPath, bundle, "version"]);
    expect(versionOut.exitCode).toBe(0);
    expect(versionOut.stdout.trim()).toBe(STAMPED_VERSION);

    const flagOut = await runCommand([process.execPath, bundle, "--version"]);
    expect(flagOut.exitCode).toBe(0);
    expect(flagOut.stdout.trim()).toBe(STAMPED_VERSION);
  });

  test("guards against the 0.0.0 placeholder once a real version is stamped", async () => {
    const guardRoot = join(root, "guard");
    const bundle = await buildCliBundle(guardRoot, "4.1.0-guard");

    const versionOut = await runCommand([process.execPath, bundle, "version"]);
    expect(versionOut.exitCode).toBe(0);
    expect(versionOut.stdout.trim()).not.toBe("0.0.0");
    expect(versionOut.stdout.trim()).toBe("4.1.0-guard");
  });

  test("falls back to the workspace package version when no version is stamped", async () => {
    const fallbackRoot = join(root, "fallback");
    const bundle = await buildCliBundle(fallbackRoot);

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
          "run",
          "../scripts/build-compiled-binary.ts",
          "--target",
          "linux-x64",
          "--outfile",
          outfile,
          "--version",
          "8.8.8-stamped",
        ]);
        expect(build.exitCode).toBe(0);

        const versionOut = await runCommand([outfile, "version"]);
        expect(versionOut.exitCode).toBe(0);
        expect(versionOut.stdout.trim()).toBe("8.8.8-stamped");
        expect(versionOut.stdout.trim()).not.toBe("0.0.0");

        const flagOut = await runCommand([outfile, "--version"]);
        expect(flagOut.exitCode).toBe(0);
        expect(flagOut.stdout.trim()).toBe("8.8.8-stamped");

        const helpOut = await runCommand([outfile, "--help"]);
        expect(helpOut.exitCode).toBe(0);
        expect(helpOut.stdout).toContain("8.8.8-stamped");

        const doctorHome = join(root, "doctor-home");
        const doctorOut = await new Promise<RunResult>((resolvePromise) => {
          const proc = Bun.spawn({
            cmd: [outfile, "doctor", "--format=json"],
            cwd: root,
            env: {
              ...process.env,
              HOME: doctorHome,
              LANDO_USER_CONF_ROOT: join(doctorHome, "conf"),
              LANDO_USER_DATA_ROOT: join(doctorHome, "data"),
              LANDO_USER_CACHE_ROOT: join(doctorHome, "cache"),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
            ([exitCode, stdout, stderr]) => resolvePromise({ exitCode, stdout, stderr }),
          );
        });
        const doctorEnvelope = JSON.parse(doctorOut.stdout) as {
          readonly result?: { readonly version?: unknown };
        };
        expect(doctorEnvelope.result?.version).toBe("8.8.8-stamped");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
