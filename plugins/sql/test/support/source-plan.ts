import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import { DateTime } from "effect";

export const sourcePlan = (root: string, type = "mysql:8.0", names: readonly string[] = ["database"]) => {
  const provider = ProviderId.make("test");
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    source: "fixture",
    runtime: 4 as const,
  };
  return AppPlan.make({
    id: AppId.make("shop"),
    name: "shop",
    slug: "shop",
    root: AbsolutePath.make(root),
    provider,
    services: Object.fromEntries(
      names.map((name) => [
        ServiceName.make(name),
        ServicePlan.make({
          name: ServiceName.make(name),
          type,
          provider,
          primary: true,
          environment: {
            MYSQL_USER: "source-user",
            MYSQL_PASSWORD: "source-secret",
            MYSQL_DATABASE: "source-db",
            POSTGRES_USER: "source-user",
            POSTGRES_PASSWORD: "source-secret",
            POSTGRES_DB: "source-db",
            MONGO_INITDB_ROOT_USERNAME: "source-user",
            MONGO_INITDB_ROOT_PASSWORD: "source-secret",
            MONGO_INITDB_DATABASE: "source-db",
          },
          mounts: [],
          storage: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        }),
      ]),
    ),
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  });
};
