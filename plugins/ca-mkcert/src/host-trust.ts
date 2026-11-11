import { X509Certificate } from "node:crypto";
import tls from "node:tls";

const fingerprint = (pem: string): string | undefined => {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

/** Default and system stores. The default Mozilla set does not contain a mkcert root. */
const hostTrustPems = (): readonly string[] => {
  const reader = tls as typeof tls & {
    getCACertificates?: (type?: "default" | "system") => readonly string[];
  };
  if (typeof reader.getCACertificates !== "function") return [...tls.rootCertificates];
  return [...new Set([...reader.getCACertificates("default"), ...reader.getCACertificates("system")])];
};

/** True when `pem` is already in the host trust store. Does not install anything. */
export const hostTrustsPem = (pem: string): boolean => {
  const root = fingerprint(pem);
  if (root === undefined) return false;
  return hostTrustPems().some((candidate) => fingerprint(candidate) === root);
};
