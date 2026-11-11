import { describe, expect, test } from "bun:test";

import { AbsolutePath } from "@lando/sdk/schema";

import { plannedServiceArtifact } from "../../src/operations/planned-service-artifact.ts";

describe("plannedServiceArtifact", () => {
  test("keeps a registry ref and digest and drops provenance", () => {
    expect(
      plannedServiceArtifact({
        kind: "ref",
        ref: "php:8.4-apache-bookworm",
        digest: "sha256:abc",
        origin: "build",
      }),
    ).toEqual({
      kind: "ref",
      ref: "php:8.4-apache-bookworm",
      digest: "sha256:abc",
    });
  });

  test("keeps a build content hash and drops context, args, and source", () => {
    expect(
      plannedServiceArtifact({
        kind: "build",
        context: AbsolutePath.make("/srv/app"),
        args: { TOKEN: "secret" },
        specInline: "FROM scratch",
        contentHash: "hash",
      }),
    ).toEqual({ kind: "build", contentHash: "hash" });
  });

  test("omits an absent artifact", () => {
    expect(plannedServiceArtifact(undefined)).toBeUndefined();
  });
});
