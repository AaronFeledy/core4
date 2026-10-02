import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type AppRef,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

export const app: AppRef = { kind: "user", id: "gpg-test", root: AbsolutePath.make("/apps/gpg-test") };
const metadata: AppPlan["metadata"] = {
  resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00Z"),
  source: "test",
  runtime: 4,
};
const service = (name: string, eligible: boolean): ServicePlan => ({
  name: ServiceName.make(name),
  type: "lando",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: { KEEP: "yes" },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: eligible ? { "@lando/core/gpg-agent": { forward: true } } : {},
});
export const plan: AppPlan = {
  id: AppId.make(app.id),
  name: app.id,
  slug: app.id,
  root: app.root,
  provider: ProviderId.make("lando"),
  services: {
    [ServiceName.make("web")]: service("web", true),
    [ServiceName.make("db")]: service("db", false),
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata,
};
