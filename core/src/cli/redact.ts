import type { Redactor } from "@lando/sdk/secrets";

export const redactString = (value: string, redactor: Redactor): string => redactor.redactString(value);

export const redactDetails = (value: unknown, redactor: Redactor): unknown => redactor.redactValue(value);
