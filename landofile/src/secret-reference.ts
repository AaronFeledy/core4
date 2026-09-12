const EXACT_SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/u;

export const exactSecretReferenceId = (value: string): string | undefined =>
  EXACT_SECRET_REFERENCE.exec(value)?.[1];

export const withoutSecretReferences = (value: string): string =>
  value.replace(/\$\{secret:[^}\r\n]+\}/gu, "");

export const isServiceEnvironmentSecretReference = (
  value: string,
  path: ReadonlyArray<string | number>,
): boolean =>
  path.length === 4 &&
  path[0] === "services" &&
  typeof path[1] === "string" &&
  path[2] === "environment" &&
  typeof path[3] === "string" &&
  exactSecretReferenceId(value) !== undefined;
