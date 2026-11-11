import { X509Certificate } from "node:crypto";

/** Larger than a local root. Anything bigger is ignored rather than handed to TLS. */
const MAX_ADDITIONAL_CA_PEM_LENGTH = 8192;

/**
 * PEMs safe to add to one request's trust set. A value that does not parse as a
 * certificate authority is dropped so it cannot make every HTTPS request fail.
 */
export const acceptedAdditionalCaPems = (pems: readonly string[] | undefined): readonly string[] => {
  if (pems === undefined || pems.length === 0) return [];
  const accepted: string[] = [];
  for (const pem of pems) {
    if (pem.length === 0 || pem.length > MAX_ADDITIONAL_CA_PEM_LENGTH) continue;
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(pem);
    } catch (cause) {
      if (cause instanceof Error) continue;
      throw cause;
    }
    if (certificate.ca) accepted.push(pem);
  }
  return accepted;
};
