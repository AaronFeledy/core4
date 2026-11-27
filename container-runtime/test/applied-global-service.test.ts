import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime } from "effect";
import { ownsAppliedGlobalService } from "../src/applied-global-service.ts";
import { containerOwnershipLabels } from "../src/native-ownership.ts";

test("a global container is owned by the root its labels were written with, not the plan's location", () => {
  // Given a global plan whose location differs from its canonical owner root, and a container
  // labelled by the one container-label producer.
  const appRoot = AbsolutePath.make("/private/data/global");
  const plan: AppPlan = {
    id: AppId.make("global"),
    name: "global",
    slug: "global",
    root: AbsolutePath.make("/data/global"),
    identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
    provider: ProviderId.make("lando"),
    services: {
      [ServiceName.make("traefik")]: {
        name: ServiceName.make("traefik"),
        type: "compose",
        provider: ProviderId.make("lando"),
        primary: true,
        artifact: { kind: "ref", ref: "traefik:3" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
        extensions: {},
      },
    },
    stores: [],
    routes: [],
    fileSync: [],
    metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
    extensions: {},
  };
  const labels = containerOwnershipLabels(plan, "traefik");
  const row: ServiceRuntimeInfo = {
    app: plan.id,
    appRoot: labels["dev.lando.app-root"],
    providerId: plan.provider,
    service: ServiceName.make("traefik"),
    containerId: "traefik-container",
    labels,
    status: "running",
    publications: { status: "present", bindings: [] },
  };

  // When the applied global plan is matched against that container.
  // Then it owns the container.
  expect(ownsAppliedGlobalService(plan, row)).toBe(true);
});
