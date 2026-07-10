import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUNTIME_BUNDLE_SOURCES_PATH,
  assembleBundle,
  parseRuntimeBundleSources,
} from "../../../scripts/assemble-runtime-bundle.ts";

const realisticPortableLdd = `
	linux-vdso.so.1 (0x00007ffc00000000)
	libsqlite3.so.0 => /lib/x86_64-linux-gnu/libsqlite3.so.0 (0x00007f0000000000)
	libsystemd.so.0 => /lib/x86_64-linux-gnu/libsystemd.so.0 (0x00007f0000000000)
	libseccomp.so.2 => /lib/x86_64-linux-gnu/libseccomp.so.2 (0x00007f0000000000)
	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)
	/lib64/ld-linux-x86-64.so.2 (0x00007f0000000000)
`;

const podmanSourceBytes = new TextEncoder().encode("pinned-podman-source");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const fixtureSourceArchive = async (dir: string): Promise<Uint8Array> => {
  const sourceDir = await mkdtemp(join(tmpdir(), "rb-src-fixture-"));
  try {
    await mkdir(join(sourceDir, "podman-6.0.1"), { recursive: true });
    await Bun.$`tar -czf ${join(dir, "podman-source.tar.gz")} -C ${sourceDir} podman-6.0.1`.quiet();
    return await readFile(join(dir, "podman-source.tar.gz"));
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
};

const sourceBuildSources = (sourceArchive: Uint8Array) =>
  parseRuntimeBundleSources({
    schemaVersion: 1,
    runtimeVersion: "9.9.9-source",
    bundles: {
      "linux-x64": {
        components: [
          {
            name: "podman",
            version: "6.0.1",
            url: "https://example.test/podman-source.tar.gz",
            sha256: sha256(sourceArchive),
            archive: "tar.gz",
            installName: "bin/podman",
            mode: 493,
            sourceBuild: "podman-linux-native",
          },
        ],
      },
    },
  });

describe("Linux Podman source build", () => {
  test("committed Linux pins use the official 6.0.1 source archive", async () => {
    const sources = parseRuntimeBundleSources(
      JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8")),
    );
    expect(sources.runtimeVersion).toBe("0.1.2");

    for (const hostKey of ["linux-x64", "linux-arm64"]) {
      const podman = sources.bundles[hostKey]?.components.find((component) => component.name === "podman");
      expect(podman).toMatchObject({
        version: "6.0.1",
        url: "https://github.com/containers/podman/archive/refs/tags/v6.0.1.tar.gz",
        sha256: "4829d7c1423523a6a4d5537dea7968ae7f6c22ed7f1d5f416638fd81c83caa47",
        sourceBuild: "podman-linux-native",
        installName: "bin/podman",
      });
    }
  });

  test("source-builds Linux Podman before managed-service verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-source-"));
    try {
      const sourceArchive = await fixtureSourceArchive(dir);
      const events: string[] = [];
      const runner = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
        if (command[0] === "tar") {
          await Bun.spawn({ cmd: [...command], stdout: "ignore", stderr: "ignore" }).exited;
          return;
        }
        if (command[0] === "make") {
          events.push("build");
          expect(command).toContain("bin/podman");
          expect(command).toContain("GIT_COMMIT=4cabbe61fa3a27fafc4a3ee1226e38ae1664ae57");
          expect(command).toContain("SOURCE_DATE_EPOCH=1783532707");
          expect(command).toContain("CGO_ENABLED=1");
          expect(command).toContain("GOFLAGS=-trimpath -buildvcs=false");
          expect(command).toContain("BUILDTAGS=grpcnotrace libsqlite3 systemd seccomp");
          expect(command).toContain("EXTRA_LDFLAGS=-buildid=");
          if (cwd === undefined) throw new Error("source build requires cwd");
          await mkdir(join(cwd, "bin"), { recursive: true });
          await writeFile(join(cwd, "bin", "podman"), podmanSourceBytes);
          return;
        }
        events.push("verify");
        expect(command[0]?.endsWith("/bin/podman")).toBe(true);
      };

      await assembleBundle({
        hostKey: "linux-x64",
        sources: sourceBuildSources(sourceArchive),
        outDir: dir,
        fetchArtifact: async () => sourceArchive,
        inspectCommand: async () => {
          events.push("portability");
          return realisticPortableLdd;
        },
        verifyCommand: runner,
      });

      expect(events).toEqual(["build", "portability", "verify"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails Linux Podman portability before deterministic packing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-portable-before-pack-"));
    try {
      const sourceArchive = await fixtureSourceArchive(dir);
      const artifactPath = join(dir, "lando-runtime-linux-x64.tar.gz");
      const runner = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
        if (command[0] === "tar" && command.includes("-xzf")) {
          await Bun.spawn({ cmd: [...command], stdout: "ignore", stderr: "ignore" }).exited;
          return;
        }
        if (command[0] === "make") {
          if (cwd === undefined) throw new Error("source build requires cwd");
          await mkdir(join(cwd, "bin"), { recursive: true });
          await writeFile(join(cwd, "bin", "podman"), podmanSourceBytes);
          return;
        }
      };

      let failure: unknown;
      try {
        await assembleBundle({
          hostKey: "linux-x64",
          sources: sourceBuildSources(sourceArchive),
          outDir: dir,
          fetchArtifact: async () => sourceArchive,
          inspectCommand: async () => {
            throw new Error("libsubid.so.4 => not found");
          },
          verifyCommand: runner,
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(await Bun.file(artifactPath).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing Linux Podman source-build output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-source-missing-"));
    try {
      const sourceArchive = await fixtureSourceArchive(dir);
      let failure: unknown;
      try {
        await assembleBundle({
          hostKey: "linux-x64",
          sources: sourceBuildSources(sourceArchive),
          outDir: dir,
          fetchArtifact: async () => sourceArchive,
          inspectCommand: async () => realisticPortableLdd,
          verifyCommand: async () => {},
        });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : "").toMatch(/source-build output.*bin\/podman/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
