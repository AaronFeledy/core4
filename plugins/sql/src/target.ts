import { SqlServiceAmbiguousError, SqlServiceNotFoundError } from "@lando/sdk/errors";
import { type DatabaseConnection, canonicalSqlitePath } from "@lando/sdk/schema";
import { Result } from "effect";

import { type SqlFamily, familyFromServiceType } from "./families.ts";

export type SqlServerTarget = {
  readonly kind: "server";
  readonly name: string;
  readonly type: string;
  readonly family: SqlFamily;
};

export type SqlFileTarget = {
  readonly kind: "file";
  readonly name: string;
  readonly type: string;
  readonly family: "sqlite";
  readonly path: string;
};

export type SqlTarget = SqlServerTarget | SqlFileTarget;

export type SqlTargetPlan = {
  readonly services: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly type: string;
        readonly connection?: DatabaseConnection;
        readonly sqlite?: { readonly path: string };
      }
    >
  >;
};

export const NOT_FOUND_REMEDIATION = "Add a mysql, mariadb, postgres, mongodb, mssql, or sqlite service.";

export const sqlCandidates = (plan: SqlTargetPlan): ReadonlyArray<SqlTarget> =>
  Object.values(plan.services)
    .flatMap((service): ReadonlyArray<SqlTarget> => {
      const family = service.connection?.family ?? familyFromServiceType(service.type);
      const server: ReadonlyArray<SqlTarget> =
        family === undefined ? [] : [{ kind: "server", name: service.name, type: service.type, family }];
      if (service.sqlite === undefined) return server;
      return [
        ...server,
        {
          kind: "file",
          name: service.name,
          type: service.type,
          family: "sqlite",
          path: canonicalSqlitePath(service.sqlite.path),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));

const notFound = (
  available: ReadonlyArray<string>,
  service: string | undefined,
): Result.Result<SqlTarget, SqlServiceNotFoundError> =>
  Result.fail(
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
): Result.Result<SqlTarget, SqlServiceNotFoundError | SqlServiceAmbiguousError> => {
  const candidates = sqlCandidates(plan);
  const available = candidates.map((candidate) => candidate.name);
  if (candidates.length === 0) return notFound(available, requested);

  if (requested !== undefined) {
    const matches = candidates.filter((candidate) => candidate.name === requested);
    const [match] = matches;
    if (match === undefined) return notFound(available, requested);
    if (matches.length === 1) return Result.succeed(match);
  }

  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return Result.succeed(only);

  return Result.fail(
    new SqlServiceAmbiguousError({
      message: "Multiple SQL services are available.",
      available,
      remediation: "Pass --service <name>.",
    }),
  );
};
