/**
 * Redaction helpers used by the CLI failure formatter.
 *
 * These are thin shims over the canonical `@lando/sdk/secrets` `secrets`
 * profile. Existing callers (`bug-report`, `doctor-subsystems`,
 * `setup-readiness`, `scenario-context`) keep importing `redactString` /
 * `redactDetails` from here so call sites stay unchanged; the actual masking
 * lives in one place.
 */

import { createRedactor } from "@lando/sdk/secrets";

const secretsRedactor = createRedactor("secrets");

export const redactString = (value: string): string => secretsRedactor.redactString(value);

export const redactDetails = (value: unknown): unknown => secretsRedactor.redactValue(value);
