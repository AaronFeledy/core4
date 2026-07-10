import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          name: "fixture-engine",
          version: "6.0.0",
          url: "https://example.test/podman-linux-amd64",
          sha256: sha256(podmanBytes),
          archive: "none" as const,
          installName: "bin/fixture-engine",
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

const acceptVerification = async (): Promise<void> => {};

describe("parseRuntimeBundleSources", () => {
  test("accepts a well-formed pins document", () => {
    const parsed = parseRuntimeBundleSources(fixtureSources());
    expect(parsed.runtimeVersion).toBe("9.9.9-fixture");
    expect(parsed.bundles["linux-x64"]?.components).toHaveLength(2);
  });

  test("rejects a placeholder / all-zero sha256 (fail closed)", () => {
    const doc = fixtureSources();
    const [component] = doc.bundles["linux-x64"].components;
    if (component === undefined) throw new Error("fixture requires a component");
    component.sha256 = "0".repeat(64);
    expect(() => parseRuntimeBundleSources(doc)).toThrow();
  });

  test("rejects a non-HTTPS component url (fail closed)", () => {
    const doc = fixtureSources();
    const [component] = doc.bundles["linux-x64"].components;
    if (component === undefined) throw new Error("fixture requires a component");
    component.url = "http://example.test/insecure";
    expect(() => parseRuntimeBundleSources(doc)).toThrow();
  });

  test("rejects Linux Podman remote-static pins", () => {
    const doc = fixtureSources();
    const [component] = doc.bundles["linux-x64"].components;
    if (component === undefined) throw new Error("fixture requires a component");
    component.name = "podman";
    component.installName = "bin/podman";
    component.url =
      "https://github.com/containers/podman/releases/download/v6.0.1/podman-remote-static-linux_amd64.tar.gz";
    expect(() => parseRuntimeBundleSources(doc)).toThrow(/linux.*podman.*remote-static/i);
  });

  test("rejects every Linux Podman binary pin without the native source build", () => {
    const doc = fixtureSources();
    const [component] = doc.bundles["linux-x64"].components;
    if (component === undefined) throw new Error("fixture requires a component");
    component.name = "podman";
    component.installName = "bin/podman";
    component.url = "https://example.test/podman-local-engine-binary";
    expect(() => parseRuntimeBundleSources(doc)).toThrow(/linux.*podman.*source-built/i);
  });

  test("rejects source-build outputs that try to bundle host-provided uidmap helpers", () => {
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-fixture",
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
                    sha256: sha256(podmanBytes),
                    archive: "tar.xz",
                  },
                ],
                outputs: [{ source: "passt", installName: "bin/newuidmap", mode: 493 }],
              },
            ],
          },
        },
      }),
    ).toThrow(/newuidmap.*newgidmap.*must not be bundled/i);
  });

  test("accepts non-Linux Podman remote client pins", () => {
    const parsed = parseRuntimeBundleSources({
      schemaVersion: 1,
      runtimeVersion: "9.9.9-fixture",
      bundles: {
        "darwin-arm64": {
          components: [
            {
              name: "podman",
              version: "6.0.1",
              url: "https://github.com/containers/podman/releases/download/v6.0.1/podman-remote-release-darwin_arm64.zip",
              sha256: sha256(podmanBytes),
              archive: "zip",
              member: "podman-6.0.1/usr/bin/podman",
              installName: "bin/podman",
              mode: 493,
            },
          ],
        },
      },
    });

    const [podman] = parsed.bundles["darwin-arm64"]?.components ?? [];
    expect(podman !== undefined && "url" in podman ? podman.url : undefined).toContain(
      "podman-remote-release",
    );
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
        verifyCommand: acceptVerification,
      });
      const second = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirB,
        fetchArtifact: fetchFixture,
        verifyCommand: acceptVerification,
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
      let failure: unknown;
      try {
        await assembleBundle({
          hostKey: "linux-x64",
          sources,
          outDir: dir,
          fetchArtifact: badFetch,
          verifyCommand: acceptVerification,
        });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : "").toMatch(/sha256|checksum|verify/i);
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
                name: "single-gzip-helper",
                version: "2.0.0",
                url: "https://example.test/single-gzip-helper.gz",
                sha256: sha256(gz),
                archive: "gz",
                installName: "bin/single-gzip-helper",
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
        verifyCommand: acceptVerification,
      });
      const second = await assembleBundle({
        hostKey: "linux-x64",
        sources,
        outDir: dirB,
        fetchArtifact: fetchGz,
        verifyCommand: acceptVerification,
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
      let failure: unknown;
      try {
        await assembleBundle({ hostKey: "darwin-arm64", sources, outDir: dir, fetchArtifact: fetchFixture });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : "").toMatch(/host key|unknown|no components/i);
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

  test("declares a version suitable for an immutable runtime release tag", async () => {
    const sources = await readCommitted();
    expect(sources.runtimeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test("every component pins a real HTTPS url and non-placeholder sha256", async () => {
    const sources = await readCommitted();
    for (const group of Object.values(sources.bundles)) {
      for (const component of group.components) {
        if ("inputs" in component) {
          for (const input of component.inputs) {
            expect(input.url.startsWith("https://")).toBe(true);
            expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(/^0+$/.test(input.sha256)).toBe(false);
          }
        } else {
          expect(component.url.startsWith("https://")).toBe(true);
          expect(component.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(/^0+$/.test(component.sha256)).toBe(false);
        }
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
