import { createRedactor } from "@lando/sdk/secrets";

const secretsRedactor = createRedactor("secrets");

export const redactString = (value: string): string => secretsRedactor.redactString(value);

export const redactDetails = (value: unknown): unknown => secretsRedactor.redactValue(value);
