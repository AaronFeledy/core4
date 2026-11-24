import { X509Certificate } from "node:crypto";
import tls from "node:tls";

export const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const fingerprint = (pem: string): string | undefined => {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

/**
 * The system store as this process loaded it. The default set is left out on purpose: it adds
 * process overrides such as `NODE_EXTRA_CA_CERTS`, which browsers and other tools never read.
 */
const systemTrustPems = (): readonly string[] =>
  typeof tls.getCACertificates === "function" ? tls.getCACertificates("system") : [];

/** True when `pems` holds `root`, compared by SHA-256 fingerprint. Unparsable entries never match. */
export const pemsContainRoot = (pems: ReadonlyArray<string>, root: string): boolean => {
  const wanted = fingerprint(root);
  if (wanted === undefined) return false;
  return pems.some((candidate) => fingerprint(candidate) === wanted);
};

/**
 * True when the system trust store held `pem` when this process loaded it. Cheap, but cached per
 * process, so it cannot confirm trust installed later. Does not install anything.
 */
export const hostTrustsPem = (pem: string): boolean => pemsContainRoot(systemTrustPems(), pem);
