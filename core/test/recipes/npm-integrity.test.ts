import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { NpmRegistryTransport } from "@lando/source-acquisition";
import { withTestSources } from "@lando/source-acquisition/testing";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";

const tarballUrl = "https://registry.example/recipe-package/-/recipe-package-1.0.0.tgz";
const bytes = new TextEncoder().encode("archive-bytes");

const transport = (dist: {
  readonly tarball: string;
  readonly integrity?: string;
  readonly shasum?: string;
}): NpmRegistryTransport => ({
  registryFor: () => "https://registry.example/",
  packument: async () => ({
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        dist,
      },
    },
  }),
  tarball: async () => bytes,
});

describe("npm integrity domain via source store", () => {
  test("missing integrity fails materialize with integrity-missing", async () => {
    // Given / When
    await withTestSources(
      {
        stateStore: makeTestStateStore().service,
        npmRegistry: transport({ tarball: tarballUrl }),
      },
      ({ session }) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            session.acquireNpm({ name: "recipe-package", selector: "1.0.0" }),
          );
          // Then
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              _tag: "SourceAcquisitionError",
              kind: "integrity-missing",
              source: "recipe-package@1.0.0",
            });
            expect(result.failure.message).toMatch(/no verifiable integrity or shasum/i);
            expect(result.failure.remediation).toMatch(/dist\.integrity|dist\.shasum/i);
          }
        }),
    );
  });

  test("integrity mismatch fails materialize with tagged remediation", async () => {
    // Given / When
    await withTestSources(
      {
        stateStore: makeTestStateStore().service,
        npmRegistry: transport({
          tarball: tarballUrl,
          integrity: "sha512-wrong",
        }),
      },
      ({ session }) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            session.acquireNpm({ name: "recipe-package", selector: "1.0.0" }),
          );
          // Then
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              _tag: "SourceAcquisitionError",
              kind: "integrity-mismatch",
              source: "recipe-package@1.0.0",
            });
            expect(result.failure.message).toMatch(/failed sha512 integrity verification/i);
            expect(result.failure.remediation).toBe(
              "The downloaded tarball does not match the registry integrity; retry or report the package.",
            );
          }
        }),
    );
  });

  test("matching sha512 integrity verifies and materializes", async () => {
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await withTestSources(
      {
        stateStore: makeTestStateStore().service,
        npmRegistry: transport({ tarball: tarballUrl, integrity }),
      },
      ({ session }) =>
        Effect.gen(function* () {
          const snap = yield* session.acquireNpm({ name: "recipe-package", selector: "1.0.0" });
          expect(snap.pin.version).toBe("1.0.0");
          expect(snap.key.kind).toBe("archive");
        }),
    );
  });
});
