import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime } from "effect";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-10T18:51:00Z"),
  source: "test",
  runtime: 4 as const,
};
export const testProviderPlan: AppPlan = {
  valueModel: 1,
  id: AppId.make("myapp"),
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
  provider: ProviderId.make("test"),
  services: {
    [ServiceName.make("web")]: {
      name: ServiceName.make("web"),
      type: "node",
      provider: ProviderId.make("test"),
      primary: true,
      artifact: { kind: "ref", ref: "node:22-alpine" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
