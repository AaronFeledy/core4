import { createStandaloneRedactor } from "@lando/redaction/service";

// CLI diagnostics must observe secret values registered after this shim is imported.
const secretsRedactor = createStandaloneRedactor("secrets");

export const redactString = (value: string): string => secretsRedactor.redactString(value);

export const redactDetails = (value: unknown): unknown => secretsRedactor.redactValue(value);
