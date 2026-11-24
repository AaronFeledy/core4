/**
 * A fresh read of the host's system trust store. Bun snapshots the system store once per process,
 * so setup cannot use that snapshot to verify the trust `mkcert -install` just added; this module
 * reads the store again every time. It only reads: it never installs, prompts, or elevates.
 */
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrustStoreStatus } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

import { PEM_BLOCK, pemsContainRoot } from "./host-trust.ts";
import { failureDetail } from "./mkcert-command.ts";

export const INSTALL_TRUST_REMEDIATION = "Run `lando setup` without `--skip-install-ca`.";

/** Distro CA bundles, in the order OpenSSL-based clients on each family find them. */
export const LINUX_SYSTEM_BUNDLES: ReadonlyArray<string> = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/** Read-only probes are fast; a hung one must not hang setup or doctor. */
const PROBE_TIMEOUT_MS = 30_000;

export interface SystemTrustOptions {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly platform: string;
  /** Linux bundle candidates; defaults to `LINUX_SYSTEM_BUNDLES`. */
  readonly linuxBundles?: ReadonlyArray<string> | undefined;
}

const storeName = (platform: string): string => {
  switch (platform) {
    case "darwin":
      return "macOS keychain";
    case "win32":
      return "Windows certificate store";
    default:
      return "System trust store";
  }
};

const firstReadable = async (paths: ReadonlyArray<string>) => {
  for (const path of paths) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) return { path, text };
  }
  return undefined;
};

const sha1Hex = (pem: string): string | undefined => {
  try {
    return new X509Certificate(pem).fingerprint.replaceAll(":", "");
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

export const makeSystemTrust = ({ processRunner, platform, linuxBundles }: SystemTrustOptions) => {
  const name = storeName(platform);
  const untrusted = (detail: string, location?: string): TrustStoreStatus => ({
    id: "system",
    name,
    ...(location === undefined ? {} : { location }),
    state: "untrusted",
    reason: "missing",
    detail,
    remediation: INSTALL_TRUST_REMEDIATION,
  });
  const unknown = (detail: string): TrustStoreStatus => ({
    id: "system",
    name,
    state: "unknown",
    reason: "inspection-failed",
    detail,
    remediation: INSTALL_TRUST_REMEDIATION,
  });

  /** Run a probe; a failure means Lando could not run it at all. */
  const probe = (cmd: string, args: ReadonlyArray<string>) =>
    processRunner.run({ cmd, args, timeoutMs: PROBE_TIMEOUT_MS }).pipe(Effect.result);

  const inspectLinux = Effect.fnUntraced(function* (root: string) {
    const bundles = linuxBundles ?? LINUX_SYSTEM_BUNDLES;
    const bundle = yield* Effect.promise(() => firstReadable(bundles));
    if (bundle === undefined) return unknown(`None of ${bundles.join(", ")} is readable.`);
    if (pemsContainRoot(bundle.text.match(PEM_BLOCK) ?? [], root)) {
      return { id: "system", name, location: bundle.path, state: "trusted" } satisfies TrustStoreStatus;
    }
    return untrusted("The bundle does not include the local CA.", bundle.path);
  });

  const inspectDarwin = Effect.fnUntraced(function* (caroot: string) {
    const args = ["verify-cert", "-l", "-L", "-R", "offline", "-p", "ssl", "-c", join(caroot, "rootCA.pem")];
    const ran = yield* probe("/usr/bin/security", args);
    if (Result.isFailure(ran)) {
      return unknown(`Lando could not run \`security verify-cert\`: ${ran.failure.message}`);
    }
    if (ran.success.exitCode === 0)
      return { id: "system", name, state: "trusted" } satisfies TrustStoreStatus;
    return untrusted(`\`security verify-cert\` rejected the local CA: ${failureDetail(ran.success)}.`);
  });

  const inspectWindows = Effect.fnUntraced(function* (root: string) {
    const sha1 = sha1Hex(root);
    if (sha1 === undefined) return unknown("The local CA is not a readable certificate.");
    for (const scope of [["-user"], []]) {
      const ran = yield* probe("certutil", [...scope, "-store", "Root", sha1]);
      if (Result.isFailure(ran)) return unknown(`Lando could not run \`certutil\`: ${ran.failure.message}`);
      if (ran.success.exitCode === 0)
        return { id: "system", name, state: "trusted" } satisfies TrustStoreStatus;
    }
    return untrusted("Neither the user nor the machine Root store holds the local CA.");
  });

  return {
    /** The system store's view of `root`, which lives in `caroot`. Never fails. */
    inspect: (caroot: string, root: string): Effect.Effect<TrustStoreStatus> => {
      switch (platform) {
        case "darwin":
          return inspectDarwin(caroot);
        case "win32":
          return inspectWindows(root);
        default:
          return inspectLinux(root);
      }
    },
  };
};

export type SystemTrust = ReturnType<typeof makeSystemTrust>;
