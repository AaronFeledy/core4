import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  RUNTIME_BUNDLE_SOURCES_PATH,
  assembleBundle,
  parseRuntimeBundleSources,
} from "../../../scripts/assemble-runtime-bundle.ts";
import { RUNTIME_BUNDLE_PUBLISH_TARGET_KEYS } from "../../../scripts/build-runtime-bundle-workflow.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const podmanBytes = new TextEncoder().encode("pinned-podman-binary");
const crunBytes = new TextEncoder().encode("pinned-crun-binary");

const fixtureSources = () => ({
  schemaVersion: 1 as const,
  runtimeVersion: "9.9.9-fixture",
  bundles: {
    "linux-x64": {
      components: [
        {
          name: "podman",
          version: "6.0.0",
          url: "https://example.test/podman-linux-amd64",
          sha256: sha256(podmanBytes),
          archive: "none" as const,
          installName: "bin/podman",
          mode: 493,
        },
        {
          name: "crun",
          version: "1.20",
          url: "https://example.test/crun-linux-amd64",
          sha256: sha256(crunBytes),
          archive: "none" as const,
          installName: "bin/crun",
          mode: 493,
        },
      ],
    },
  },
});

const fetchFixture = async (url: string): Promise<Uint8Array> => {
  if (url.endsWith("podman-linux-amd64")) return podmanBytes;
  if (url.endsWith("crun-linux-amd64")) return crunBytes;
  throw new Error(`unexpected fixture url ${url}`);
};

describe("parseRuntimeBundleSources", () => {
  test("accepts a well-formed pins document", () => {
    const parsed = parseRuntimeBundleSources(fixtureSources());
    expect(parsed.runtimeVersion).toBe("9.9.9-fixture");
    expect(parsed.bundles["linux-x64"]?.components).toHaveLength(2);
  });

  test("rejects a placeholder / all-zero sha256 (fail closed)", () => {
    const doc = fixtureSources();
    doc.bundles["linux-x64"].components[0].sha256 = "0".repeat(64);
    expect(() => parseRuntimeBundleSources(doc)).toThrow();
  });

  test("rejects a non-HTTPS component url (fail closed)", () => {
    const doc = fixtureSources();
    doc.bundles["linux-x64"].components[0].url = "http://example.test/insecure";
    expect(() => parseRuntimeBundleSources(doc)).toThrow();
  });
});

describe("assembleBundle", () => {
  test("is reproducible: identical pins produce identical bundle SHA-256s", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "rb-asm-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "rb-asm-b-"));
    try {
      const sources = parseRuntimeBundleSources(fixtureSources());
      const first = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirA,
        fetchArtifact: fetchFixture,
      });
      const second = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirB,
        fetchArtifact: fetchFixture,
      });

      expect(first.filename).toBe("lando-runtime-linux-x64.tar.gz");
      expect(second.sha256).toBe(first.sha256);
      const bytesA = await readFile(first.artifactPath);
      const bytesB = await readFile(second.artifactPath);
      expect(sha256(bytesB)).toBe(sha256(bytesA));
      expect(first.sha256).toBe(sha256(bytesA));
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  test("fails closed when a downloaded artifact's SHA-256 does not match the pin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-bad-"));
    try {
      const sources = parseRuntimeBundleSources(fixtureSources());
      const badFetch = async (): Promise<Uint8Array> => new TextEncoder().encode("tampered");
      await expect(
        assembleBundle({ hostKey: "linux-x64", sources, outDir: dir, fetchArtifact: badFetch }),
      ).rejects.toThrow(/sha256|checksum|verify/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts a single-file gzip component (archive: gz) and stays reproducible", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "rb-gz-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "rb-gz-b-"));
    try {
      const netavarkBinary = new TextEncoder().encode("pinned-netavark-binary");
      const gz = Bun.gzipSync(netavarkBinary);
      const sources = parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-gz",
        bundles: {
          "linux-x64": {
            components: [
              {
                name: "netavark",
                version: "2.0.0",
                url: "https://example.test/netavark.gz",
                sha256: sha256(gz),
                archive: "gz",
                installName: "bin/netavark",
                mode: 493,
              },
            ],
          },
        },
      });
      const fetchGz = async (): Promise<Uint8Array> => gz;
      const first = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirA,
        fetchArtifact: fetchGz,
      });
      const second = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirB,
        fetchArtifact: fetchGz,
      });
      expect(second.sha256).toBe(first.sha256);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  test("rejects an unknown host key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-unknown-"));
    try {
      const sources = parseRuntimeBundleSources(fixtureSources());
      await expect(
        assembleBundle({ hostKey: "darwin-arm64", sources, outDir: dir, fetchArtifact: fetchFixture }),
      ).rejects.toThrow(/host key|unknown|no components/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("committed runtime-bundle-sources.json", () => {
  const readCommitted = async () =>
    parseRuntimeBundleSources(JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8")));

  test("parses under the fail-closed schema", async () => {
    const sources = await readCommitted();
    expect(sources.schemaVersion).toBe(1);
  });

  test("pins exactly the four runtime host keys and never darwin-x64", async () => {
    const sources = await readCommitted();
    expect(Object.keys(sources.bundles).sort()).toEqual([...RUNTIME_BUNDLE_PUBLISH_TARGET_KEYS].sort());
    expect(sources.bundles).not.toHaveProperty("darwin-x64");
  });

  test("runtimeVersion matches the runtime-bundle-version file", async () => {
    const sources = await readCommitted();
    const versionFile = join(dirname(RUNTIME_BUNDLE_SOURCES_PATH), "runtime-bundle-version");
    const pinnedVersion = (await readFile(versionFile, "utf8")).trim();
    expect(sources.runtimeVersion).toBe(pinnedVersion);
  });

  test("every component pins a real HTTPS url and non-placeholder sha256", async () => {
    const sources = await readCommitted();
    for (const group of Object.values(sources.bundles)) {
      for (const component of group.components) {
        expect(component.url.startsWith("https://")).toBe(true);
        expect(component.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(/^0+$/.test(component.sha256)).toBe(false);
      }
    }
  });

  test("pins Podman 6 for every platform", async () => {
    const sources = await readCommitted();
    for (const group of Object.values(sources.bundles)) {
      const podman = group.components.find((component) => component.name === "podman");
      expect(podman?.version.startsWith("6.")).toBe(true);
    }
  });
});
