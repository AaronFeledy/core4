import {
  type AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

export const globalLifecyclePlan = (root: AbsolutePath, names: ReadonlyArray<string>): AppPlan => {
  const provider = ProviderId.make("lando");
  const metadata = {
    runtime: 4 as const,
    resolvedAt: DateTime.makeUnsafe(0),
    source: "global-lifecycle-fixture",
  };
  return {
    id: AppId.make("global"),
    name: "global",
    slug: "global",
    root,
    provider,
    metadata,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    services: Object.fromEntries(
      names.map((name) => [
        name,
        ServicePlan.make({
          name: ServiceName.make(name),
          type: "compose",
          provider,
          primary: false,
          artifact: { kind: "ref", ref: "fixture:v1" },
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        }),
      ]),
    ),
    routes: names.map((name) => ({
      hostname: `${name}.lndo.site`,
      service: ServiceName.make(name),
      priority: 1,
      scheme: "http",
      endpoint: 80,
      backend: { service: ServiceName.make(name), protocol: "http", port: 80 },
    })),
    stores: [],
    fileSync: [],
    extensions: {},
  };
};
