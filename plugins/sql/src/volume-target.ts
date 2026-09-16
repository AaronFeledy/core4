import { Effect } from "effect";

import { VolumeNotFoundError } from "@lando/sdk/errors";

import { type SqlFamily, familyFromServiceType } from "./families.ts";
import type { SqlPlanService } from "./views.ts";

const destinations = {
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  postgres: "/var/lib/postgresql/data",
  mongodb: "/data/db",
  mssql: "/var/opt/mssql",
} as const satisfies Readonly<Record<SqlFamily, string>>;

export const requireDatabaseMount = (
  service: SqlPlanService,
  app: string,
): Effect.Effect<{ readonly store: string; readonly target: string }, VolumeNotFoundError> => {
  const family = familyFromServiceType(service.type);
  const destination = family === undefined ? undefined : destinations[family];
  const matches = service.storage.filter(
    (mount) => destination !== undefined && mount.target === destination,
  );
  const mount = matches[0];
  return matches.length === 1 && mount?.target !== undefined
    ? Effect.succeed({ store: mount.store, target: mount.target })
    : Effect.fail(
        new VolumeNotFoundError({
          message: `Service ${service.name} has no unambiguous database volume.`,
          store: service.name,
          app,
          remediation: "Provide exactly one persistent mount at the database family's data destination.",
        }),
      );
};
