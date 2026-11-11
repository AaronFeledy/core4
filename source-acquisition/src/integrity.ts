import { createHash } from "node:crypto";
import type { NpmPackageDist } from "./types.ts";

export type NpmIntegrityResult =
  | { readonly status: "verified" }
  | { readonly status: "unverifiable" }
  | { readonly status: "mismatch"; readonly description: string; readonly remediation: string };

// npm's first SRI token wins. Unsupported/malformed SRI falls back to legacy sha1.
export const checkNpmPackageDistIntegrity = (bytes: Uint8Array, dist: NpmPackageDist): NpmIntegrityResult => {
  if (dist.integrity !== undefined && dist.integrity.trim() !== "") {
    const entry = dist.integrity.trim().split(/\s+/u)[0] ?? "";
    const dash = entry.indexOf("-");
    const algorithm = dash > 0 ? entry.slice(0, dash) : "";
    const expected = dash > 0 ? entry.slice(dash + 1) : "";
    if (algorithm !== "" && expected !== "") {
      let actual: string | undefined;
      try {
        actual = createHash(algorithm).update(bytes).digest("base64");
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        actual = undefined;
      }
      if (actual !== undefined)
        return actual === expected
          ? { status: "verified" }
          : {
              status: "mismatch",
              description: `failed ${algorithm} integrity verification.`,
              remediation:
                "The downloaded tarball does not match the registry integrity; retry or report the package.",
            };
    }
  }
  if (dist.shasum !== undefined && dist.shasum.trim() !== "") {
    return createHash("sha1").update(bytes).digest("hex") === dist.shasum.trim().toLowerCase()
      ? { status: "verified" }
      : {
          status: "mismatch",
          description: "failed sha1 shasum verification.",
          remediation:
            "The downloaded tarball does not match the registry shasum; retry or report the package.",
        };
  }
  return { status: "unverifiable" };
};
