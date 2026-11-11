import type { SecretReferenceInvalidError } from "@lando/sdk/errors";
import type { ExecutionSiteMatch } from "@lando/sdk/landofile/execution-sites";
import { type ParsedSecretReference, parseSecretReference } from "@lando/sdk/secrets";
import { Result } from "effect";

const EXACT_SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/u;

export const SECRET_BINDING_SITES: ReadonlyArray<{
  readonly label: string;
  readonly paths: ReadonlyArray<string>;
  readonly matches: (path: readonly (string | number)[]) => boolean;
}> = [
  {
    label: "a service `environment` value",
    paths: ["services.<name>.environment.<KEY>"],
    matches: (path) => path[0] === "services" && path[2] === "environment" && path.length === 4,
  },
  {
    label: "a database password",
    paths: ["services.<name>.creds.password", "services.<name>.creds.rootPassword"],
    matches: (path) =>
      path[0] === "services" &&
      path[2] === "creds" &&
      path.length === 4 &&
      (path[3] === "password" || path[3] === "rootPassword"),
  },
  {
    label: "a Redis password",
    paths: ["services.<name>.password"],
    matches: (path) => path[0] === "services" && path[2] === "password" && path.length === 3,
  },
  {
    label: "a tooling `env` value",
    paths: ["tooling.<task>.env.<KEY>", "tooling.<task>.cmds.<index>.env.<KEY>", "toolingDefaults.env.<KEY>"],
    matches: (path) =>
      (path[0] === "tooling" &&
        ((path[2] === "env" && path.length === 4) ||
          (path[2] === "cmds" && path[4] === "env" && path.length === 6))) ||
      (path[0] === "toolingDefaults" && path[1] === "env" && path.length === 3),
  },
  {
    label: "a tooling var `env` value",
    paths: ["tooling.<task>.vars.<name>.env.<KEY>"],
    matches: (path) => path[0] === "tooling" && path[2] === "vars" && path[4] === "env" && path.length === 6,
  },
  {
    label: "an event step `env` value",
    paths: ["events.<event>.<index>.env.<KEY>"],
    matches: (path) =>
      path[0] === "events" && typeof path[2] === "number" && path[3] === "env" && path.length === 5,
  },
];

export const eligibleBindingPath = (path: readonly (string | number)[]): boolean =>
  SECRET_BINDING_SITES.some((site) => site.matches(path));

/**
 * Shell command sites that Lando lowers itself at invocation instead of rejecting
 * the reference at load. argv forms and every other command site stay rejected.
 */
export const isLoweredSecretReferenceSite = (
  match: ExecutionSiteMatch | undefined,
  path: readonly (string | number)[],
): boolean => {
  if (match === undefined) return false;
  switch (match.site) {
    case "tooling-cmd":
    case "tooling-task":
    case "tooling-var":
      return match.relativePath.length === 0;
    case "tooling-cmds":
      return (
        (match.relativePath.length === 1 && typeof match.relativePath[0] === "number") ||
        (match.relativePath.length === 2 &&
          typeof match.relativePath[0] === "number" &&
          match.relativePath[1] === "cmd")
      );
    case "event-step": {
      const leaf = path.at(-1);
      return (
        match.relativePath.length === 0 && (typeof leaf === "number" || leaf === "cmd" || leaf === "defer")
      );
    }
    default:
      return false;
  }
};

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
