#!/usr/bin/env bun
/**
 * Regenerate `data-mover/src/generated/provider-images.ts`: the pinned
 * `{ image, digest }` manifest for provider images Lando provisions at the
 * provider-image layer.
 *
 * The generic-fallback `tar` helper image (`dataHelper`) is resolved from this
 * manifest through `RuntimeProvider.pullArtifact`, digest-verified, cached, and
 * offline-reused like every other Lando-provisioned artifact.
 *
 * Drift gate: re-run + `git diff --exit-code` on the output. The generated TS
 * is byte-stable for a given pinned image/digest table.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatGeneratedPaths } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "data-mover/src/generated/provider-images.ts");

export interface ProviderImageEntry {
  readonly image: string;
  readonly digest: string;
}

export interface ProviderImageManifest {
  readonly schemaVersion: 1;
  readonly images: Readonly<Record<string, ProviderImageEntry>>;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const PROVIDER_IMAGES: ProviderImageManifest = {
  schemaVersion: 1,
  images: {
    dataHelper: {
      image: "docker.io/library/alpine:3.20.3",
      digest: "sha256:beefdbd8a1da6d2915566fde36db9db0b524eb737fc57cd1367effd16dc0d06d",
    },
  },
};

export const validateProviderImageManifest = (manifest: ProviderImageManifest): void => {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unexpected provider-image manifest schemaVersion: ${String(manifest.schemaVersion)}.`);
  }
  const keys = Object.keys(manifest.images);
  if (keys.length === 0) {
    throw new Error("Provider-image manifest must declare at least one image.");
  }
  for (const key of keys) {
    const entry = manifest.images[key];
    if (entry === undefined || entry.image.trim().length === 0) {
      throw new Error(`Provider-image entry "${key}" must declare a non-empty image reference.`);
    }
    if (!DIGEST_PATTERN.test(entry.digest)) {
      throw new Error(`Provider-image entry "${key}" must pin a sha256:<64-hex> digest.`);
    }
  }
};

export const renderProviderImages = (manifest: ProviderImageManifest): string => {
  validateProviderImageManifest(manifest);
  const sortedImages = Object.fromEntries(
    Object.entries(manifest.images).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sorted: ProviderImageManifest = { schemaVersion: manifest.schemaVersion, images: sortedImages };
  return `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-provider-images.ts\`.
 */
export interface ProviderImageEntry {
  readonly image: string;
  readonly digest: string;
}

export interface ProviderImageManifest {
  readonly schemaVersion: 1;
  readonly images: Readonly<Record<string, ProviderImageEntry>>;
}

export const providerImages = ${JSON.stringify(sorted, null, 2)} as const satisfies ProviderImageManifest;
`;
};

const main = async (): Promise<void> => {
  const contents = renderProviderImages(PROVIDER_IMAGES);
  await mkdir(dirname(OUTPUT), { recursive: true });
  await Bun.write(OUTPUT, contents);
  await formatGeneratedPaths([OUTPUT]);
  console.log(
    `[build-provider-images] wrote ${OUTPUT} (${Object.keys(PROVIDER_IMAGES.images).length} images)`,
  );
};

if (import.meta.main) {
  await main();
}
