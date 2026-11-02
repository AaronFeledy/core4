import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle } from "../../../scripts/assemble-runtime-bundle.ts";
import { checkRuntimeBundleLicenses } from "../../../scripts/check-runtime-bundle-licenses.ts";
import { runtimeBundleRecipeUrls } from "../../../scripts/runtime-bundle-licenses.ts";
import { parseRuntimeBundleSources } from "../../../scripts/runtime-bundle-sources.ts";
import { fixtureLicense, licenseBytes } from "./runtime-bundle-license-fixture.ts";

const component = () => ({
  name: "podman",
  version: "1.2.3",
  license: fixtureLicense("1.2.3"),
  url: "https://example.test/podman",
  sha256: fixtureLicense("1.2.3").texts[0]?.sha256,
  archive: "none" as const,
  installName: "bin/podman",
  mode: 0o755,
});
const document = (entry: unknown = component()) => ({
  schemaVersion: 1,
  runtimeVersion: "9.9.9",
  bundles: { "darwin-arm64": { components: [entry] } },
});
const noSleep = async (): Promise<void> => {};

describe("runtime license metadata", () => {
  test("requires license metadata on binary and source-built components", () => {
    const { license: _license, ...binary } = component();
    const source = {
      name: "passt",
      version: "1.2.3",
      sourceBuild: "passt-linux-native",
      inputs: [{ name: "source", url: binary.url, sha256: binary.sha256, archive: "tar.xz" }],
      outputs: [{ source: "passt", installName: "bin/passt", mode: 493 }],
    };
    expect(() => parseRuntimeBundleSources(document(binary))).toThrow();
    expect(() => parseRuntimeBundleSources(document(source))).toThrow();
  });
  test.each(["0".repeat(64), "bad-sha"])("rejects invalid license checksum %s", (sha256) => {
    const entry = component();
    entry.license.texts = [{ file: "LICENSE", url: "https://example.test/1.2.3/LICENSE", sha256 }];
    expect(() => parseRuntimeBundleSources(document(entry))).toThrow();
  });
  test.each(["source", "text"])("rejects non-HTTPS %s links", (kind) => {
    const entry = component();
    if (kind === "source") entry.license.source = "http://example.test/1.2.3";
    else for (const text of entry.license.texts) text.url = "http://example.test/1.2.3/LICENSE";
    expect(() => parseRuntimeBundleSources(document(entry))).toThrow();
  });
  test.each([
    ["2.2.1", "https://example.test/v2.2.10.tar.gz"],
    ["2.2.1", "https://example.test/v2.2.1.5.tar.gz"],
    ["1.1", "https://example.test/v1.17.tar.gz"],
  ])("rejects source for %s that only names a different version: %s", (version, source) => {
    const entry = { ...component(), version, license: { ...fixtureLicense(version), source } };
    expect(() => parseRuntimeBundleSources(document(entry))).toThrow();
  });
  test.each([
    ["2.2.1", "https://example.test/archive/refs/tags/v2.2.1.tar.gz"],
    ["1.28", "https://example.test/archive/refs/tags/1.28.tar.gz"],
    // Debian binary versions may name only the upstream or source-package token.
    ["0.2.1-2+b14", "https://example.test/archive/refs/tags/v0.2.1.tar.gz"],
    ["0.2.1-2+b14", "https://example.test/pool/main/c/catatonit/catatonit_0.2.1.orig.tar.gz"],
    ["0.2.1-2+b14", "https://example.test/changelogs/catatonit_0.2.1-2_copyright"],
  ])("accepts source for %s naming the exact version: %s", (version, source) => {
    const entry = { ...component(), version, license: { ...fixtureLicense(version), source } };
    expect(() => parseRuntimeBundleSources(document(entry))).not.toThrow();
  });
  test("rejects Debian license.source that only names an unrelated version", () => {
    const entry = {
      ...component(),
      version: "0.2.1-2+b14",
      license: {
        ...fixtureLicense("0.2.1-2+b14"),
        source: "https://example.test/archive/refs/tags/v0.2.10.tar.gz",
      },
    };
    expect(() => parseRuntimeBundleSources(document(entry))).toThrow();
  });
  test("rejects unversioned sources, empty texts, duplicate files and unsafe filenames", () => {
    const entry = component();
    expect(() =>
      parseRuntimeBundleSources(
        document({ ...entry, license: { ...entry.license, source: "https://example.test/main" } }),
      ),
    ).toThrow();
    expect(() =>
      parseRuntimeBundleSources(document({ ...entry, license: { ...entry.license, texts: [] } })),
    ).toThrow();
    expect(() =>
      parseRuntimeBundleSources(
        document({
          ...entry,
          license: { ...entry.license, texts: [...entry.license.texts, ...entry.license.texts] },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRuntimeBundleSources(
        document({
          ...entry,
          license: { ...entry.license, texts: [{ ...entry.license.texts[0], file: "../LICENSE" }] },
        }),
      ),
    ).toThrow();
  });
});

describe("runtime license live checker", () => {
  test("checks license bytes and falls back to ranged GET when HEAD is unsupported", async () => {
    const calls: string[] = [];
    const violations = await checkRuntimeBundleLicenses({
      repository: "AaronFeledy/core4",
      sources: document(),
      live: true,
      sleep: noSleep,
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/LICENSE")) return new Response(licenseBytes);
        if (init?.method === "HEAD") return new Response(null, { status: 405 });
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-0");
        return new Response("x", { status: 206 });
      },
    });
    expect(violations).toEqual([]);
    expect(calls).toHaveLength(3);
  });
  test.each(["license", "source"])("reports %s 404 with its URL", async (kind) => {
    const entry = component();
    const missing = kind === "source" ? entry.license.source : entry.license.texts[0]?.url;
    const result = await checkRuntimeBundleLicenses({
      repository: "AaronFeledy/core4",
      sources: document(entry),
      live: true,
      sleep: noSleep,
      fetchImpl: async (url) => new Response(licenseBytes, { status: url === missing ? 404 : 200 }),
    });
    expect(result).toEqual([
      expect.objectContaining({ url: missing, message: expect.stringContaining("404") }),
    ]);
  });
  test("reports checksum mismatch and retries transient failures", async () => {
    let calls = 0;
    const result = await checkRuntimeBundleLicenses({
      repository: "AaronFeledy/core4",
      sources: document(),
      live: true,
      sleep: noSleep,
      fetchImpl: async (url) => {
        if (!url.endsWith("/LICENSE")) return new Response(null);
        calls += 1;
        return calls === 1 ? new Response(null, { status: 503 }) : new Response("tampered");
      },
    });
    expect(calls).toBe(2);
    expect(result).toEqual([
      expect.objectContaining({ message: expect.stringContaining("sha256 mismatch") }),
    ]);
  });
  test("offline mode reports metadata errors without fetching", async () => {
    expect(
      await checkRuntimeBundleLicenses({
        repository: "AaronFeledy/core4",
        sources: {},
        fetchImpl: async () => {
          throw new Error("network forbidden");
        },
      }),
    ).toHaveLength(1);
    expect(
      await checkRuntimeBundleLicenses({
        repository: "AaronFeledy/core4",
        sources: document(),
        fetchImpl: async () => {
          throw new Error("network forbidden");
        },
      }),
    ).toEqual([]);
  });
  test.each(["9.9.9", "0.1.6"])(
    "checks recipe links only after version %s is published",
    async (publishedRuntimeVersion) => {
      const entry = { ...component(), sourceBuild: "podman-linux-native" };
      const calls: string[] = [];
      const result = await checkRuntimeBundleLicenses({
        repository: "AaronFeledy/core4",
        sources: document(entry),
        live: true,
        publishedRuntimeVersion,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(licenseBytes);
        },
      });
      expect(result).toEqual([]);
      expect(calls.some((url) => url.includes("AaronFeledy/core4/tree/runtime-v9.9.9/scripts"))).toBe(
        publishedRuntimeVersion === "9.9.9",
      );
    },
  );
  const netavark = (version: string) => {
    const parsed = parseRuntimeBundleSources(
      document({
        name: "netavark",
        version,
        license: fixtureLicense(version),
        sourceBuild: "netavark-linux-native",
        inputs: [
          {
            name: "source",
            url: `https://example.test/netavark-${version}.tar.gz`,
            sha256: fixtureLicense(version).texts[0]?.sha256,
            archive: "tar.gz",
          },
        ],
        outputs: [{ source: "netavark", installName: "bin/netavark", mode: 0o755 }],
      }),
    );
    const entry = parsed.bundles["darwin-arm64"]?.components[0];
    if (entry === undefined) throw new Error("missing fixture");
    return entry;
  };
  test("links netavark's patch only for the version the build patches", () => {
    expect(runtimeBundleRecipeUrls(netavark("2.0.0"), "9.9.9", "AaronFeledy/core4")).toEqual([
      "https://github.com/AaronFeledy/core4/tree/runtime-v9.9.9/scripts",
      "https://github.com/AaronFeledy/core4/tree/runtime-v9.9.9/scripts/patches/netavark-v2.0.0-systemd-user-bus.patch",
    ]);
    expect(runtimeBundleRecipeUrls(netavark("2.1.0"), "9.9.9", "AaronFeledy/core4")).toEqual([
      "https://github.com/AaronFeledy/core4/tree/runtime-v9.9.9/scripts",
    ]);
  });
});

describe("bundled license payload", () => {
  test.each(["darwin-arm64", "win32-x64"])(
    "packs original license bytes and notices reproducibly for %s",
    async (hostKey) => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-licenses-"));
      try {
        const sources = parseRuntimeBundleSources({
          ...document(),
          bundles: { [hostKey]: { components: [component()] } },
        });
        const options = {
          hostKey,
          sources,
          outDir: dir,
          repository: "AaronFeledy/core4",
          fetchArtifact: async () => licenseBytes,
        };
        const first = await assembleBundle(options);
        const firstBytes = await readFile(first.artifactPath);
        const second = await assembleBundle(options);
        expect(await readFile(second.artifactPath)).toEqual(firstBytes);
        const contents = async (path: string) =>
          hostKey === "win32-x64"
            ? Bun.$`unzip -p ${first.artifactPath} ${path}`.quiet().arrayBuffer()
            : Bun.$`tar -xOf ${first.artifactPath} ${`./${path}`}`.quiet().arrayBuffer();
        expect(new Uint8Array(await contents("bin/licenses/podman/LICENSE"))).toEqual(licenseBytes);
        expect(new Uint8Array(await contents("bin/podman"))).toEqual(licenseBytes);
        const notices = new TextDecoder().decode(await contents("bin/licenses/THIRD_PARTY_NOTICES.md"));
        expect(notices).toContain("podman 1.2.3");
        expect(notices).toContain("SPDX: MIT");
        expect(notices).toContain(component().license.source);
        expect(notices).toContain("podman/LICENSE");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  test("fails closed on license tampering before fetching a binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-license-tamper-"));
    const calls: string[] = [];
    try {
      await expect(
        assembleBundle({
          repository: "AaronFeledy/core4",
          hostKey: "darwin-arm64",
          sources: parseRuntimeBundleSources(document()),
          outDir: dir,
          fetchArtifact: async (url) => {
            calls.push(url);
            return new TextEncoder().encode("tampered");
          },
        }),
      ).rejects.toThrow(/sha256 verify failed.*license/u);
      expect(calls).toEqual(["https://example.test/1.2.3/LICENSE"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
