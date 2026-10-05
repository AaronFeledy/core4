import { Schema } from "effect";

// ==== String-form patterns with caller-owned diagnostics and projection
export const KEBAB_CASE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SHA256_PREFIXED_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SEMVER_CORE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SEMVER_LOOSE_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export const patternString = (pattern: RegExp, options?: Parameters<typeof Schema.isPattern>[1]) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(pattern, options)));
