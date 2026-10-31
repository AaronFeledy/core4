import { describe, expect, test } from "bun:test";

import {
  PROVIDER_IMAGES,
  type ProviderImageManifest,
  renderProviderImages,
  validateProviderImageManifest,
} from "../../../scripts/build-provider-images.ts";

describe("provider-image manifest", () => {
  test("pins a dataHelper image with a sha256 digest", () => {
    expect(PROVIDER_IMAGES.schemaVersion).toBe(1);
    const dataHelper = PROVIDER_IMAGES.images.dataHelper;
    expect(dataHelper).toBeDefined();
    expect(dataHelper?.image.length).toBeGreaterThan(0);
    expect(dataHelper?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("pins the volume witness image by digest to the oven/bun alpine tag", () => {
    const volumeWitness = PROVIDER_IMAGES.images.volumeWitness;
    expect(volumeWitness?.image).toBe("docker.io/oven/bun:1.4.0-alpine");
    expect(volumeWitness?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("pins the sqlite helper image by digest", () => {
    const sqliteHelper = PROVIDER_IMAGES.images.sqliteHelper;
    expect(sqliteHelper?.image).toBe("docker.io/keinos/sqlite3:3.54.1");
    expect(sqliteHelper?.digest).toBe(
      "sha256:b577e65892c6468d94b390097eda4488e05253470c161bdea68a05abb961fa17",
    );
    expect(`${sqliteHelper?.image}@${sqliteHelper?.digest}`).toBe(
      "docker.io/keinos/sqlite3:3.54.1@sha256:b577e65892c6468d94b390097eda4488e05253470c161bdea68a05abb961fa17",
    );
  });

  test("validates schemaVersion, non-empty image, and digest shape", () => {
    expect(() =>
      validateProviderImageManifest({
        schemaVersion: 2 as 1,
        images: { dataHelper: { image: "x", digest: `sha256:${"a".repeat(64)}` } },
      }),
    ).toThrow();
    expect(() =>
      validateProviderImageManifest({
        schemaVersion: 1,
        images: { dataHelper: { image: "", digest: `sha256:${"a".repeat(64)}` } },
      }),
    ).toThrow();
    expect(() =>
      validateProviderImageManifest({
        schemaVersion: 1,
        images: { dataHelper: { image: "alpine", digest: "latest" } },
      }),
    ).toThrow();
    expect(() => validateProviderImageManifest({ schemaVersion: 1, images: {} })).toThrow();
  });

  test("renders deterministic, idempotent output", () => {
    const first = renderProviderImages(PROVIDER_IMAGES);
    const second = renderProviderImages(PROVIDER_IMAGES);
    expect(first).toBe(second);
    expect(first).toContain("export const providerImages");
    expect(first).toContain('"schemaVersion": 1');
    expect(first).toContain(PROVIDER_IMAGES.images.dataHelper?.image ?? "");
  });

  test("sorts image keys for byte-stable output", () => {
    const manifest: ProviderImageManifest = {
      schemaVersion: 1,
      images: {
        zebra: { image: "z", digest: `sha256:${"b".repeat(64)}` },
        alpha: { image: "a", digest: `sha256:${"c".repeat(64)}` },
      },
    };
    const rendered = renderProviderImages(manifest);
    expect(rendered.indexOf("alpha")).toBeLessThan(rendered.indexOf("zebra"));
  });
});
