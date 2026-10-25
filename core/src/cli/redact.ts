import { createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";

const secretsRedactor = createStandaloneRedactor("secrets");

export const redactString = (value: string, redactor: Redactor = secretsRedactor): string =>
  redactor.redactString(value);

export const redactDetails = (value: unknown, redactor: Redactor = secretsRedactor): unknown =>
  redactor.redactValue(value);
