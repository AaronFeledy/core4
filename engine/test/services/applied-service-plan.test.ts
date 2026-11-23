import { describe, expect, test } from "bun:test";
import { appliedStateVersionError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";

import { appliedServicePlan } from "../../src/services/execution-identity.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-15T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};

const service = (name: string, projectUser?: ServicePlan["projectUser"]): ServicePlan =>
  ({
    name: ServiceName.make(name),
    type: "php:8.3",
    provider: ProviderId.make("lando"),
    primary: name === "web",
    environment: {},
    ...(projectUser === undefined ? {} : { projectUser }),
    mounts: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  }) as ServicePlan;

const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("applied"),
  name: "Applied",
  slug: "applied",
  root: AbsolutePath.make("/tmp/applied"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const registry = (result: () => Promise<AppPlan | undefined>) =>
  makeTestRuntimeProviderRegistry({ readAppliedPlanStrict: () => Effect.promise(result) });

describe("appliedServicePlan", () => {
  test("returns the applied service, not the desired one", async () => {
    const desired: AppPlan = {
      ...plan,
      services: { [ServiceName.make("web")]: service("web", { name: "node", uid: 1000, gid: 1000 }) },
    };
    const applied: AppPlan = {
      ...plan,
      services: { [ServiceName.make("web")]: service("web", { name: "www-data", uid: 33, gid: 33 }) },
    };
    const resolved = await Effect.runPromise(
      appliedServicePlan(
        registry(async () => applied),
        desired,
        "web",
      ),
    );
    expect(resolved?.projectUser).toEqual({ name: "www-data", uid: 33, gid: 33 });
  });

  test("returns undefined when no applied plan exists", async () => {
    const resolved = await Effect.runPromise(
      appliedServicePlan(
        registry(async () => undefined),
        plan,
        "web",
      ),
    );
    expect(resolved).toBeUndefined();
  });

  test("asks for this app's exact applied plan, never an enclosing app's", async () => {
    // Applied-state resolution can walk up from the app root, so asking the
    // ancestor question would let a parent plan answer for a nested app.
    const nested: AppPlan = {
      ...plan,
      id: AppId.make("nested"),
      root: AbsolutePath.make("/tmp/applied/nested"),
    };
    const parent: AppPlan = {
      ...plan,
      services: { [ServiceName.make("web")]: service("web", { name: "www-data", uid: 33, gid: 33 }) },
    };
    const resolved = await Effect.runPromise(
      appliedServicePlan(
        makeTestRuntimeProviderRegistry({ readAppliedPlanStrict: () => Effect.succeed(parent) }),
        nested,
        "web",
      ),
    );
    expect(resolved).toBeUndefined();
  });

  test("container execution identity reports protected applied state", async () => {
    const error = appliedStateVersionError({
      providerId: plan.provider,
      appId: plan.id,
      path: "/state/app.json",
      operation: "applied-state.read",
      scope: "app",
      storedVersion: 12,
      supportedVersion: 11,
    });
    const resolved = await Effect.runPromise(
      appliedServicePlan(
        makeTestRuntimeProviderRegistry({ readAppliedPlanStrict: () => Effect.fail(error) }),
        plan,
        "web",
      ).pipe(Effect.flip),
    );
    expect(resolved).toBe(error);
  });
});
