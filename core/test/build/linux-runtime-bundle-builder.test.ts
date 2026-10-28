import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertLinuxBuilderBunPin,
  assertNativeLinuxBundle,
  buildLinuxRuntimeBundle,
} from "../../../scripts/linux-runtime-bundle-builder.ts";
import { LINUX_RUNTIME_BUNDLE_CACHE_INPUTS } from "../../../scripts/runtime-bundle-supply-chain.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const hostKey = `linux-${process.arch}`;
const filename = `lando-runtime-${hostKey}.tar.gz`;
const nativeTest = process.platform === "linux" && ["x64", "arm64"].includes(process.arch) ? test : test.skip;
const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
const withOutDir = async (run: (outDir: string) => Promise<void>): Promise<void> => {
  const outDir = await mkdtemp(join(tmpdir(), "runtime-bundle-test-"));
  try {
    await run(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
};

const exportPath = (cmd: ReadonlyArray<string>): string => {
  const output = cmd[cmd.indexOf("--output") + 1];
  expect(output).toStartWith("type=local,dest=");
  return output?.slice("type=local,dest=".length) ?? "";
};

describe("Linux runtime bundle builder", () => {
  test("requires native host and matching immutable Bun image pin", async () => {
    expect(() => assertNativeLinuxBundle("linux-arm64", "linux", "x64")).toThrow("native linux-arm64");
    expect(() => assertNativeLinuxBundle("linux-x64", "darwin", "x64")).toThrow("native linux-x64");
    const dockerfile = await readFile(join(repoRoot, "scripts/runtime-bundle-builder/Dockerfile"), "utf8");
    const bunVersion = (await readFile(join(repoRoot, ".bun-version"), "utf8")).trim();
    expect(() => assertLinuxBuilderBunPin(dockerfile, bunVersion, bunVersion)).not.toThrow();
    expect(() => assertLinuxBuilderBunPin(dockerfile, "0.0.0", bunVersion)).toThrow("pin mismatch");
    expect(dockerfile).toContain('test "$BUILDPLATFORM" = "$TARGETPLATFORM"');
    expect(dockerfile).toContain("linux-x64:amd64|linux-arm64:arm64");
    expect(dockerfile.indexOf('test "$BUILDPLATFORM"')).toBeLessThan(
      dockerfile.indexOf("COPY prerequisites.sh"),
    );
    expect(dockerfile).toContain("GOTOOLCHAIN=local");
  });

  nativeTest("transfers a minimal context and atomically exports the requested archive", async () => {
    await withOutDir(async (outDir) => {
      let context = "";
      let exported = "";
      const artifact = await buildLinuxRuntimeBundle({
        hostKey,
        outDir,
        repository: "owner/repo",
        execute: async (cmd) => {
          expect(cmd.slice(0, 3)).toEqual(["docker", "buildx", "build"]);
          expect(cmd.slice(cmd.indexOf("--platform"), cmd.indexOf("--platform") + 2)).toEqual([
            "--platform",
            process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
          ]);
          expect(cmd).toContain(`BUNDLE_PLATFORM=${hostKey}`);
          expect(cmd).toContain("REPOSITORY=owner/repo");
          context = cmd.at(-1) ?? "";
          exported = exportPath(cmd);
          expect(exported.startsWith(context)).toBe(false);
          const entries = await readdir(context, { recursive: true });
          expect(entries.sort()).toEqual(
            [
              "Dockerfile",
              "plugins",
              "plugins/provider-lando",
              "plugins/provider-lando/runtime-bundle-sources.json",
              "prerequisites.sh",
              "scripts",
              "scripts/entry.js",
              "scripts/patches",
              "scripts/patches/netavark-v2.0.0-systemd-user-bus.patch",
            ].sort(),
          );
          await writeFile(join(exported, filename), "bundle");
        },
      });
      expect(artifact).toBe(join(outDir, filename));
      expect(await readFile(artifact, "utf8")).toBe("bundle");
      expect(await pathExists(context)).toBe(false);
      expect(await pathExists(exported)).toBe(false);
    });
  });

  nativeTest("keeps the previous archive and cleans up after an export failure", async () => {
    await withOutDir(async (outDir) => {
      await writeFile(join(outDir, filename), "previous");
      let context = "";
      let exported = "";
      await expect(
        buildLinuxRuntimeBundle({
          hostKey,
          outDir,
          repository: "owner/repo",
          execute: async (cmd) => {
            context = cmd.at(-1) ?? "";
            exported = exportPath(cmd);
            throw new Error("buildx failed");
          },
        }),
      ).rejects.toThrow("buildx failed");
      expect(await readFile(join(outDir, filename), "utf8")).toBe("previous");
      expect(await pathExists(context)).toBe(false);
      expect(await pathExists(exported)).toBe(false);
      expect(await readdir(outDir)).toEqual([filename]);
    });
  });

  nativeTest("rejects a linked export without replacing an existing archive", async () => {
    await withOutDir(async (outDir) => {
      await writeFile(join(outDir, filename), "previous");
      await expect(
        buildLinuxRuntimeBundle({
          hostKey,
          outDir,
          repository: "owner/repo",
          execute: async (cmd) => {
            await symlink(join(outDir, filename), join(exportPath(cmd), filename));
          },
        }),
      ).rejects.toThrow("Invalid runtime bundle export");
      expect(await readFile(join(outDir, filename), "utf8")).toBe("previous");
      expect(await readdir(outDir)).toEqual([filename]);
    });
  });

  nativeTest.each([false, true])(
    "preserves a build failure while attempting every owned cleanup (undefined=%p)",
    async (throwUndefined) => {
      await withOutDir(async (outDir) => {
        await writeFile(join(outDir, filename), "previous");
        const cleanupLog = join(outDir, "cleanup.log");
        const script = `
        import { mock } from "bun:test";
        const fs = await import("node:fs/promises");
        const originalRm = fs.rm;
        mock.module("node:fs/promises", () => ({
          ...fs,
          rm: async (path, options) => {
            await fs.appendFile(process.env.CLEANUP_LOG, String(path) + "\\n");
            await originalRm(path, options);
            if (String(path).includes("rb-builder-")) throw new Error("injected cleanup failure");
          },
        }));
        const { buildLinuxRuntimeBundle } = await import("./scripts/linux-runtime-bundle-builder.ts");
        try {
          await buildLinuxRuntimeBundle({
            hostKey: process.env.BUNDLE_HOST_KEY,
            outDir: process.env.BUNDLE_OUT_DIR,
            repository: "owner/repo",
            execute: async () => {
              if (process.env.THROW_UNDEFINED) throw undefined;
              throw new Error("buildx failed");
            },
          });
        } catch (cause) {
          console.error(cause instanceof Error ? cause.message : String(cause));
          process.exitCode = 1;
        }
      `;
        const child = Bun.spawn([process.execPath, "-e", script], {
          cwd: repoRoot,
          env: {
            ...process.env,
            CLEANUP_LOG: cleanupLog,
            BUNDLE_HOST_KEY: hostKey,
            BUNDLE_OUT_DIR: outDir,
            ...(throwUndefined ? { THROW_UNDEFINED: "1" } : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stdout + stderr).toContain(throwUndefined ? "undefined" : "buildx failed");
        expect(stdout + stderr).not.toContain("injected cleanup failure");
        expect(await readFile(join(outDir, filename), "utf8")).toBe("previous");
        const cleaned = (await readFile(cleanupLog, "utf8")).trim().split("\n");
        expect(cleaned.some((path) => path.includes("rb-builder-"))).toBe(true);
        expect(cleaned.some((path) => path.includes("rb-export-"))).toBe(true);
      });
    },
  );

  test("cache inputs cover Bun's actual local dependency graph", async () => {
    const result = await Bun.build({
      entrypoints: [join(repoRoot, "scripts/runtime-bundle-builder/entry.ts")],
      target: "bun",
      sourcemap: "external",
    });
    expect(result.success).toBe(true);
    const map = result.outputs.find((output) => output.path.endsWith(".map"));
    expect(map).toBeDefined();
    const sources = (await map?.json()) as { sources: string[] };
    const cached = new Set<string>(LINUX_RUNTIME_BUNDLE_CACHE_INPUTS);
    const localSources = sources.sources.filter((path) => !path.startsWith("node_modules/"));
    expect(localSources.length).toBeGreaterThan(0);
    for (const source of localSources) {
      expect(
        cached.has(source) ||
          (source.startsWith("scripts/runtime-bundle-builder/") &&
            cached.has("scripts/runtime-bundle-builder/**")),
      ).toBe(true);
    }
    for (const path of [
      "package.json",
      "tsconfig.json",
      "tsconfig.base.json",
      "scripts/tsconfig.json",
      ".bun-version",
      "bun.lock",
    ]) {
      expect(cached.has(path)).toBe(true);
    }
  });
});
