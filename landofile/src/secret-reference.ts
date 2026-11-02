import type { SecretReferenceInvalidError } from "@lando/sdk/errors";
import { type ParsedSecretReference, parseSecretReference } from "@lando/sdk/secrets";
import { Result } from "effect";

const EXACT_SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/u;

export const eligibleBindingPath = (path: readonly (string | number)[]): boolean =>
  (path[0] === "services" &&
    ((path[2] === "environment" && path.length === 4) ||
      (path[2] === "creds" && path.length === 4 && (path[3] === "password" || path[3] === "rootPassword")) ||
      (path[2] === "password" && path.length === 3))) ||
  (path[0] === "tooling" &&
    ((path[2] === "env" && path.length === 4) ||
      (path[2] === "cmds" && path[4] === "env" && path.length === 6))) ||
  (path[0] === "toolingDefaults" && path[1] === "env" && path.length === 3) ||
  (path[0] === "events" && typeof path[2] === "number" && path[3] === "env" && path.length === 5);

export const exactSecretReferenceId = (value: string): string | undefined =>
  EXACT_SECRET_REFERENCE.exec(value)?.[1];

export const exactSecretReference = (
  value: string,
): ParsedSecretReference | SecretReferenceInvalidError | undefined => {
  const raw = exactSecretReferenceId(value);
  return raw === undefined ? undefined : Result.merge(parseSecretReference(raw));
};

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
