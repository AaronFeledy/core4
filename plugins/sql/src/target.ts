import { Either } from "effect";

import { SqlServiceAmbiguousError, SqlServiceNotFoundError } from "@lando/sdk/errors";

import { type SqlFamily, familyFromServiceType } from "./families.ts";

export type SqlTarget = {
  readonly name: string;
  readonly type: string;
  readonly family: SqlFamily;
};

export type SqlTargetPlan = {
  readonly services: Readonly<Record<string, { readonly name: string; readonly type: string }>>;
};

const NOT_FOUND_REMEDIATION = "Add a mysql, mariadb, postgres, mongodb, or mssql service.";

export const sqlCandidates = (plan: SqlTargetPlan): ReadonlyArray<SqlTarget> =>
  Object.values(plan.services)
    .flatMap((service) => {
      const family = familyFromServiceType(service.type);
      return family === undefined ? [] : [{ name: service.name, type: service.type, family }];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));

const notFound = (
  available: ReadonlyArray<string>,
  service: string | undefined,
): Either.Either<SqlTarget, SqlServiceNotFoundError> =>
  Either.left(
    new SqlServiceNotFoundError({
      message: service === undefined ? "No SQL service is available." : `No SQL service named ${service}.`,
      ...(service === undefined ? {} : { service }),
      available,
      remediation: NOT_FOUND_REMEDIATION,
    }),
  );

export const resolveSqlTarget = (
  plan: SqlTargetPlan,
  requested?: string,
): Either.Either<SqlTarget, SqlServiceNotFoundError | SqlServiceAmbiguousError> => {
  const candidates = sqlCandidates(plan);
  const available = candidates.map((candidate) => candidate.name);
  if (candidates.length === 0) return notFound(available, requested);

  if (requested !== undefined) {
    const match = candidates.find((candidate) => candidate.name === requested);
    return match === undefined ? notFound(available, requested) : Either.right(match);
  }

  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return Either.right(only);

  return Either.left(
    new SqlServiceAmbiguousError({
      message: "Multiple SQL services are available.",
      available,
      remediation: "Pass --service <name>.",
    }),
  );
};
