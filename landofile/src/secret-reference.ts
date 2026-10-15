import type { SecretReferenceInvalidError } from "@lando/sdk/errors";
import { type ParsedSecretReference, parseSecretReference } from "@lando/sdk/secrets";
import { Result } from "effect";

const EXACT_SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/u;
const SECRET_REFERENCE = /\$\{secret:[^}\r\n]+\}/u;

export const exactSecretReferenceId = (value: string): string | undefined =>
  EXACT_SECRET_REFERENCE.exec(value)?.[1];

export const exactSecretReference = (
  value: string,
): ParsedSecretReference | SecretReferenceInvalidError | undefined => {
  const raw = exactSecretReferenceId(value);
  return raw === undefined ? undefined : Result.merge(parseSecretReference(raw));
};

export const firstSecretReference = (value: string): string | undefined => SECRET_REFERENCE.exec(value)?.[0];

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

export const isServiceBuildArgPath = (path: ReadonlyArray<string | number>): boolean =>
  path.length === 5 &&
  path[0] === "services" &&
  typeof path[1] === "string" &&
  path[2] === "build" &&
  path[3] === "args" &&
  (typeof path[4] === "string" || typeof path[4] === "number");

export const isServiceBuildArgSecretReference = (
  value: string,
  path: ReadonlyArray<string | number>,
): boolean => isServiceBuildArgPath(path) && firstSecretReference(value) !== undefined;
