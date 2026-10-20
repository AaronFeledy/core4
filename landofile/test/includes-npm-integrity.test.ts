import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNpmPackageDistIntegrity } from "@lando/landofile/npm-integrity";
import { Effect } from "effect";
import { resolveAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const bytes = new TextEncoder().encode("archive");
const sri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const shasum = createHash("sha1").update(bytes).digest("hex");
for (const [label, metadata, status] of [
  ["SRI", { integrity: sri }, "verified"],
  ["bad SRI with valid sha1", { integrity: "sha512-wrong", shasum }, "mismatch"],
  ["sha1 case folding", { shasum: shasum.toUpperCase() }, "verified"],
  ["bad sha1", { shasum: "wrong" }, "mismatch"],
  ["unsupported SRI fallback", { integrity: "unsupported-value", shasum }, "verified"],
  ["unsupported SRI bad fallback", { integrity: "unsupported-value", shasum: "wrong" }, "mismatch"],
  ["malformed SRI fallback", { integrity: "malformed", shasum: "wrong" }, "mismatch"],
  ["first SRI only", { integrity: `${sri} sha512-wrong` }, "verified"],
  ["absent integrity", {}, "unverifiable"],
  ["unsupported SRI without shasum", { integrity: "unsupported-value" }, "unverifiable"],
] as const) {
  test(`shared integrity policy handles ${label}`, () => {
    // Given
    const dist = { tarball: "https://example.test/pkg.tgz", ...metadata };
    // When
    const result = checkNpmPackageDistIntegrity(bytes, dist);
    // Then
    expect(result.status).toBe(status);
  });
}

for (const [label, metadata, remediation] of [
  ["tampered archive", { integrity: sri }, "registry integrity"],
  ["missing integrity metadata", {}, "dist.integrity or dist.shasum"],
] as const) {
  test(`npm include rejects ${label} before extraction or lock publication`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-npm-integrity-"));
    let extracts = 0;
    try {
      // When
      const error = await Effect.runPromise(
        Effect.flip(
          resolveAuthoredIncludes({
            appRoot: root,
            cacheRoot: join(root, "cache"),
            ports: makeTestLandofilePorts(join(root, "cache")),
            stateStore: makeTestLandofileStateStore(),
            landofile: { includes: [{ source: "npm:fragments", path: "web.yml" }] },
            deps: {
              npmRecipeSource: {
                resolve: async () => ({
                  packageName: "fragments",
                  version: "1.0.0",
                  dist: { tarball: "https://example.test/pkg.tgz", ...metadata },
                }),
              },
              npmFetcher: { fetch: async () => new TextEncoder().encode("tampered") },
              npmExtractor: {
                extract: async () => {
                  extracts++;
                },
              },
            },
          }),
        ),
      );
      // Then
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind: "fetch-failed",
        remediation: expect.stringContaining(remediation),
      });
      expect(extracts).toBe(0);
      expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
