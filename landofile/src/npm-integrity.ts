import { createHash } from "node:crypto";
import type { NpmRecipePackageDist } from "./ports.ts";

interface NpmIntegrityMismatch {
  readonly status: "mismatch";
  readonly description: string;
  readonly remediation: string;
}

export type NpmIntegrityResult =
  | { readonly status: "verified" }
  | { readonly status: "unverifiable" }
  | NpmIntegrityMismatch;

// Preserve npm recipe policy: the first SRI entry wins; unsupported or
// malformed SRI falls back to shasum. Missing metadata remains unverifiable.
export const checkNpmPackageDistIntegrity = (
  bytes: Uint8Array,
  dist: NpmRecipePackageDist,
): NpmIntegrityResult => {
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
        // Unsupported algorithms follow the legacy sha1 fallback below.
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
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual.toLowerCase() !== dist.shasum.trim().toLowerCase())
      return {
        status: "mismatch",
        description: "failed sha1 shasum verification.",
        remediation:
          "The downloaded tarball does not match the registry shasum; retry or report the package.",
      };
    return { status: "verified" };
  }
  return { status: "unverifiable" };
};
