import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildNodeReleasesCatalog, readCommittedNodeReleases } from "../../../scripts/build-node-releases.ts";

const root = resolve(import.meta.dirname, "../../..");

describe("offline Node releases catalog", () => {
  test("generates a deterministic literal table from the committed manifest", async () => {
    // Given
    const manifest = await readCommittedNodeReleases(root);

    // When
    const generated = buildNodeReleasesCatalog(manifest);

    // Then
    expect(buildNodeReleasesCatalog(manifest)).toBe(generated);
    expect(generated.startsWith("/**\n * **GENERATED FILE** — do not edit by hand.")).toBe(true);
    expect(generated).toContain("export const NODE_RELEASES = [");
    expect(generated).toContain('export const SUPPORTED_NODE_VERSIONS = ["lts","22","24","26"] as const;');
    expect(generated).toContain("export const NODE_RELEASE_SOURCE =");
    for (const release of manifest.releases) {
      expect(generated).toContain(`"major": ${release.major}`);
    }
  });
});
