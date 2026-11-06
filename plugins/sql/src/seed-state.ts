import { SqlSeedStateError } from "@lando/sdk/errors";
import { absurd } from "effect";

export const seedStateError = (service: string, status: SqlSeedStateError["status"]): SqlSeedStateError => {
  const detail = (() => {
    switch (status) {
      case "seeded":
        return {
          message: `Cannot seed ${service}: this volume has already been seeded.`,
          remediation:
            "Seeding is allowed only once per fresh volume. To load into this existing database, run lando db:import <file> --yes.",
        };
      case "in-progress":
        return {
          message: `Cannot seed ${service}: this volume has an unfinished seed claim.`,
          remediation:
            "Another seed may still be running, or it stopped before recording its outcome. Wait for any running seed to finish. To load into the existing database afterward, run lando db:import <file> --yes.",
        };
      case "failed":
        return {
          message: `Cannot seed ${service}: the previous seed failed or was interrupted after claiming this volume.`,
          remediation:
            "This volume is quarantined from further seeding and may contain partial data. To load into the existing database, run lando db:import <file> --yes. For a new seed, lando destroy --volumes --yes deletes the app's data volumes; then run lando start and lando db:seed <file>.",
        };
      case "unknown":
        return {
          message: `Cannot seed ${service}: Lando has no record of creating this volume empty for this app.`,
          remediation:
            "Seeding only fills a volume that Lando created empty for this app, such as one that existed before Lando managed it or that another app created. To load into this existing database, run lando db:import <file> --yes.",
        };
      case "fresh":
        return {
          message: `Cannot seed ${service}: the database is not empty.`,
          remediation:
            "Seeding only fills an empty database, and this one already has tables or collections, or its emptiness check returned no count. To load into it anyway, run lando db:import <file> --yes.",
        };
      default:
        return absurd<never>(status);
    }
  })();
  return new SqlSeedStateError({ ...detail, service, status });
};
