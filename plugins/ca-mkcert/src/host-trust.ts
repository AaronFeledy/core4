import { X509Certificate } from "node:crypto";
import tls from "node:tls";

export const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificate in `pem`, or undefined when it does not parse. */
export const parseCertificate = (pem: string): X509Certificate | undefined => {
  try {
    return new X509Certificate(pem);
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

/** Upper-case hex SHA-1 fingerprint without separators, as Windows `certutil` takes it. */
export const sha1Hex = (pem: string): string | undefined =>
  parseCertificate(pem)?.fingerprint.replaceAll(":", "");

/**
 * The system store as this process loaded it. The default set is left out on purpose: it adds
 * process overrides such as `NODE_EXTRA_CA_CERTS`, which browsers and other tools never read.
 */
const systemTrustPems = (): readonly string[] =>
  typeof tls.getCACertificates === "function" ? tls.getCACertificates("system") : [];

/** True when `pems` holds `root`, compared by SHA-256 fingerprint. Unparsable entries never match. */
export const pemsContainRoot = (pems: ReadonlyArray<string>, root: string): boolean => {
  const wanted = parseCertificate(root)?.fingerprint256;
  if (wanted === undefined) return false;
  return pems.some((candidate) => parseCertificate(candidate)?.fingerprint256 === wanted);
};

/**
 * True when the system trust store held `pem` when this process loaded it. Cheap, but cached per
 * process, so it cannot confirm trust installed later. Does not install anything.
 */
export const hostTrustsPem = (pem: string): boolean => pemsContainRoot(systemTrustPems(), pem);
