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

const netavarkBytes = new TextEncoder().encode("pinned-netavark-binary");
const passtBytes = new TextEncoder().encode("pinned-passt-binary");
const pastaBytes = new TextEncoder().encode("pinned-pasta-binary");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const linuxHelperSources = (sourceArchive: Uint8Array, vendorArchive: Uint8Array) =>
  parseRuntimeBundleSources({
    schemaVersion: 1,
    runtimeVersion: "9.9.9-source",
    hostProvidedHelpers: ["newuidmap", "newgidmap"],
    bundles: {
      "linux-x64": {
        components: [
          {
            name: "netavark",
            version: "2.0.0",
            sourceBuild: "netavark-linux-native",
            inputs: [
              {
                name: "source",
                url: "https://example.test/netavark-source.tar.gz",
                sha256: sha256(sourceArchive),
                archive: "tar.gz",
              },
              {
                name: "vendor",
                url: "https://example.test/netavark-vendor.tar.gz",
                sha256: sha256(vendorArchive),
                archive: "tar.gz",
              },
            ],
            outputs: [{ source: "target/release/netavark", installName: "bin/netavark", mode: 493 }],
          },
        ],
      },
    },
  });

const passtSources = (sourceArchive: Uint8Array) =>
  parseRuntimeBundleSources({
    schemaVersion: 1,
    runtimeVersion: "9.9.9-source",
    hostProvidedHelpers: ["newuidmap", "newgidmap"],
    bundles: {
      "linux-x64": {
        components: [
          {
            name: "passt",
            version: "2026_06_11.a9c61ff",
            sourceBuild: "passt-linux-native",
            inputs: [
              {
                name: "source",
                url: "https://example.test/passt.tar.xz",
                sha256: sha256(sourceArchive),
                archive: "tar.xz",
              },
            ],
            outputs: [
              { source: "passt", installName: "bin/passt", mode: 493 },
              { source: "pasta", installName: "bin/pasta", mode: 493 },
            ],
          },
        ],
      },
    },
  });

describe("Linux helper source builds", () => {
  test("committed Linux helper pins use native source-build inputs", async () => {
    const sources = parseRuntimeBundleSources(
      JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8")),
    );

    expect(sources.hostProvidedHelpers).toEqual(["newuidmap", "newgidmap"]);
    for (const hostKey of ["linux-x64", "linux-arm64"]) {
      const components = sources.bundles[hostKey]?.components ?? [];
      expect(
        components.find(
          (component) => "installName" in component && component.installName === "bin/newuidmap",
        ),
      ).toBeUndefined();
      expect(
        components.find(
          (component) => "installName" in component && component.installName === "bin/newgidmap",
        ),
      ).toBeUndefined();
      expect(components.find((component) => component.name === "netavark")).toMatchObject({
        version: "2.0.0",
        sourceBuild: "netavark-linux-native",
        inputs: [
          {
            name: "source",
            sha256: "031aeeacc930382e8635d40a885798eff1da164dfcf9024b698f822e5995d9c8",
          },
          {
            name: "vendor",
            sha256: "86de7eb3a4e9ecc4acd5addc462879e8f2bac3562a4b99f12a4be67e5218c2cb",
          },
        ],
      });
      expect(components.find((component) => component.name === "aardvark-dns")).toMatchObject({
        version: "2.0.0",
        sourceBuild: "aardvark-dns-linux-native",
        inputs: [
          {
            name: "source",
            sha256: "d3f5d6b3be3c2d80e8257fb9467e34ff104f299474427979454034dca6dc88cc",
          },
          {
            name: "vendor",
            sha256: "c5ca49d98c535fa3c8d0d195512faf1f8610ad9ca4f62bec73c7bbfc4ddcc0b6",
          },
        ],
      });
      expect(components.find((component) => component.name === "passt")).toMatchObject({
        version: "2026_06_11.a9c61ff",
        sourceBuild: "passt-linux-native",
        inputs: [
          {
            archive: "tar.xz",
            sha256: "b94b235cb96ce1b7aeab6552b7e0b4c9a780e5d700ced500c65e429b2d8b8450",
          },
        ],
        outputs: [{ installName: "bin/passt" }, { installName: "bin/pasta" }],
      });
    }
  });

  test("source-builds Netavark from source plus vendored dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-netavark-"));
    try {
      await mkdir(join(dir, "netavark-2.0.0"), { recursive: true });
      await mkdir(join(dir, "vendor"), { recursive: true });
      await Bun.$`tar -czf ${join(dir, "netavark-source.tar.gz")} -C ${dir} netavark-2.0.0`.quiet();
      await Bun.$`tar -czf ${join(dir, "netavark-vendor.tar.gz")} -C ${dir} vendor`.quiet();
      const sourceArchive = await readFile(join(dir, "netavark-source.tar.gz"));
      const vendorArchive = await readFile(join(dir, "netavark-vendor.tar.gz"));
      const events: string[] = [];
      const runner = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
        if (command[0] === "tar") {
          await Bun.spawn({ cmd: [...command], stdout: "ignore", stderr: "ignore" }).exited;
          return;
        }
        if (command.includes("cargo")) {
          events.push("build");
          expect(command).toContain("build");
          expect(command).toContain("--release");
          expect(command).toContain("--locked");
          expect(command).toContain("--offline");
          expect(command).toContain("SOURCE_DATE_EPOCH=0");
          if (cwd === undefined) throw new Error("source build requires cwd");
          await mkdir(join(cwd, "target", "release"), { recursive: true });
          await writeFile(join(cwd, "target", "release", "netavark"), netavarkBytes);
          return;
        }
        events.push("verify");
      };

      await assembleBundle({
        hostKey: "linux-x64",
        sources: linuxHelperSources(sourceArchive, vendorArchive),
        outDir: dir,
        fetchArtifact: async (url) => (url.includes("vendor") ? vendorArchive : sourceArchive),
        verifyCommand: runner,
      });

      expect(events).toEqual(["build", "verify"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("source-builds passt and installs both passt and pasta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-passt-"));
    try {
      await mkdir(join(dir, "passt-2026_06_11.a9c61ff"), { recursive: true });
      await Bun.$`tar -cJf ${join(dir, "passt.tar.xz")} -C ${dir} passt-2026_06_11.a9c61ff`.quiet();
      const sourceArchive = await readFile(join(dir, "passt.tar.xz"));
      const runner = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
        if (command[0] === "tar") {
          await Bun.spawn({ cmd: [...command], stdout: "ignore", stderr: "ignore" }).exited;
          return;
        }
        if (command[0] === "make") {
          expect(command).toContain("passt");
          expect(command).toContain("pasta");
          if (cwd === undefined) throw new Error("source build requires cwd");
          await writeFile(join(cwd, "passt"), passtBytes);
          await writeFile(join(cwd, "pasta"), pastaBytes);
          return;
        }
      };

      await assembleBundle({
        hostKey: "linux-x64",
        sources: passtSources(sourceArchive),
        outDir: dir,
        fetchArtifact: async () => sourceArchive,
        verifyCommand: runner,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
