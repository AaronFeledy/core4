import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  ensureNetworkTrustCaBundle,
  loadBunCaCertificates,
} from "../../src/cli/commands/bun-child-ca-bundle";

test.each([
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  "-----BEGIN PRIVATE KEY-----\nprivate-key-canary\n-----END PRIVATE KEY-----\n",
  "-----BEGIN CERTIFICATE-----\nincomplete-canary",
  `${rootCertificates[0]}\ncredential-canary`,
])("rejects invalid or non-certificate PEM material without persisting it", async (text) => {
  const root = await mkdtemp(join(tmpdir(), "lando-ca-validation-"));
  try {
    const path = join(root, "ca.pem");
    await writeFile(path, text);
    const fs = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));

    const error = await Effect.runPromise(Effect.flip(loadBunCaCertificates([path], fs)));

    expect(error).toMatchObject({ _tag: "BunChildNetworkPolicyError", kind: "invalid-ca" });
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(await Bun.file(join(root, "network-trust")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a multi-certificate file deduplicates certificates across all input paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-ca-multi-"));
  try {
    const path = join(root, "multi.pem");
    await writeFile(path, `${rootCertificates[0]}\n${rootCertificates[1]}\n`);
    const fs = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));

    const cas = await Effect.runPromise(loadBunCaCertificates([path, path], fs));

    expect(cas).toHaveLength(2);
    expect(new Set(cas.map((ca) => ca.digest)).size).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged digest-named bundle is rejected rather than overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-ca-immutable-"));
  try {
    const cas = [{ pem: "certificate-body", digest: "fixture" }];
    const bundle = await Effect.runPromise(ensureNetworkTrustCaBundle({ userCacheRoot: root, cas }));
    if (bundle === undefined) throw new Error("Expected CA bundle");
    await writeFile(bundle.bundlePath, "damaged-bundle");

    const error = await Effect.runPromise(
      Effect.flip(ensureNetworkTrustCaBundle({ userCacheRoot: root, cas })),
    );

    expect(error).toMatchObject({ _tag: "BunChildNetworkPolicyError", kind: "bundle-write" });
    expect(await readFile(bundle.bundlePath, "utf8")).toBe("damaged-bundle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
