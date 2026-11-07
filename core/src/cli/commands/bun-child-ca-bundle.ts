import { X509Certificate } from "node:crypto";
import { dirname } from "node:path";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { networkTrustCaBundlePath } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import type { HostPlatform } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { BunChildNetworkPolicyError } from "./bun-child-network-policy";

type CaCertificate = { readonly pem: string; readonly digest: string };
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

export const loadBunCaCertificates = Effect.fn("BunChildCaBundle.load")(function* (
  paths: readonly string[],
  fs: Context.Service.Shape<typeof FileSystem>,
) {
  const cas: CaCertificate[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const text = yield* fs.readText(path).pipe(
      Effect.mapError(
        () =>
          new BunChildNetworkPolicyError({
            kind: "invalid-ca",
            message: `Could not read CA certificates at ${path}.`,
            remediation:
              "Point network.ca.certs or LANDO_NETWORK_CA_CERTS at readable PEM certificate files.",
          }),
      ),
    );
    const blocks = [...text.matchAll(PEM_BLOCK)].map((match) => match[0]);
    const parsed = yield* Effect.try({
      try: () => {
        if (blocks.length === 0 || text.replace(PEM_BLOCK, "").trim() !== "") return undefined;
        return blocks.map((block) => new X509Certificate(block).toString());
      },
      catch: () =>
        new BunChildNetworkPolicyError({
          kind: "invalid-ca",
          message: `Invalid PEM certificate at ${path}.`,
          remediation: "Use complete, valid PEM CERTIFICATE blocks without private keys or other content.",
        }),
    });
    if (parsed === undefined)
      return yield* Effect.fail(
        new BunChildNetworkPolicyError({
          kind: "invalid-ca",
          message: `Incomplete PEM certificate material at ${path}.`,
          remediation: "Use complete PEM CERTIFICATE blocks without private keys or other content.",
        }),
      );
    for (const pem of parsed) {
      const normalized = pem.endsWith("\n") ? pem : `${pem}\n`;
      const digest = sha256Hex(normalized);
      if (!seen.has(digest)) {
        seen.add(digest);
        cas.push({ pem: normalized, digest });
      }
    }
  }
  return cas;
});

export const ensureNetworkTrustCaBundle = Effect.fn("BunChildCaBundle.publish")(function* (input: {
  readonly userCacheRoot: string;
  readonly cas: readonly CaCertificate[];
  readonly platform?: HostPlatform;
  readonly fileSystem?: Context.Service.Shape<typeof FileSystem>;
}) {
  if (input.cas.length === 0) return undefined;
  const fs = input.fileSystem ?? (yield* FileSystem.pipe(Effect.provide(BunFileSystem.layer)));
  const body = input.cas.map((ca) => ca.pem).join("");
  const digest = sha256Hex(body);
  const bundlePath = networkTrustCaBundlePath(input.userCacheRoot, digest, input.platform);
  return yield* Effect.gen(function* () {
    if (yield* fs.exists(bundlePath)) {
      if ((yield* fs.readText(bundlePath)) !== body)
        return yield* Effect.fail(
          new BunChildNetworkPolicyError({
            kind: "bundle-write",
            message: `The immutable CA bundle at ${bundlePath} has unexpected content.`,
            remediation: "Remove the damaged CA bundle from the Lando cache and retry.",
          }),
        );
      return { bundlePath, digest };
    }
    yield* fs.mkdir(dirname(bundlePath));
    yield* fs.writeAtomic(bundlePath, body);
    return { bundlePath, digest };
  }).pipe(
    Effect.mapError(
      () =>
        new BunChildNetworkPolicyError({
          kind: "bundle-write",
          message: `Could not publish immutable CA bundle at ${bundlePath}.`,
          remediation:
            "Check the Lando cache permissions and remove a damaged digest-named bundle before retrying.",
        }),
    ),
  );
});
