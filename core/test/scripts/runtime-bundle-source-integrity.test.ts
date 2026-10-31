import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkRuntimeBundleLicenses } from "../../../scripts/check-runtime-bundle-licenses.ts";
import { readRuntimeBundleSources } from "../../../scripts/runtime-bundle-sources.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test.each(["digest", "size"] as const)(
  "live verification rejects a Debian source %s mismatch",
  async (damage) => {
    const sources = await readRuntimeBundleSources();
    const catatonit = sources.bundles["linux-x64"]?.components.find(
      (component) => component.name === "catatonit",
    );
    if (catatonit === undefined || !("archive" in catatonit) || catatonit.archive !== "deb")
      throw new Error("Debian component missing");
    const sourceBytes = new TextEncoder().encode("source-archive");
    const licenseBytes = new TextEncoder().encode("license-text");
    const component = {
      ...catatonit,
      source: {
        ...catatonit.source,
        sha256: damage === "digest" ? "a".repeat(64) : digest(sourceBytes),
        sizeBytes: sourceBytes.length + (damage === "size" ? 1 : 0),
      },
      license: {
        ...catatonit.license,
        texts: [{ file: "COPYING", url: "https://example.test/COPYING", sha256: digest(licenseBytes) }],
      },
    };
    const violations = await checkRuntimeBundleLicenses({
      sources: { ...sources, bundles: { "linux-x64": { components: [component] } } },
      live: true,
      repository: "AaronFeledy/core4",
      fetchImpl: async (url) => new Response(url === component.source.url ? sourceBytes : licenseBytes),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.url).toBe(component.source.url);
    expect(violations[0]?.message).toContain(damage === "size" ? "size mismatch" : "sha256 mismatch");
  },
);
