import { describe, expect, it } from "bun:test";

import { HomePathCapabilityError } from "@lando/sdk/errors";
import { PortablePath, type ServiceConfig, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import {
  applyServiceHome,
  containerTargetKey,
  hasCustomImage,
  homeStoreName,
  resolveHomePath,
  serviceHomeIntent,
} from "../../src/planner/home.ts";

const identity: ServiceImageIdentity = {
  defaultUser: "node",
  homes: { node: "/home/node", root: "/root" },
};

const intentFor = (service: ServiceConfig, declared: ServiceImageIdentity | undefined = identity) =>
  serviceHomeIntent({ service, serviceTypeId: "node:22", identity: declared });

const planWith = (overrides: Partial<ServicePlan> = {}): ServicePlan =>
  ({
    name: "web",
    type: "node:22",
    provider: "test",
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: { resolvedAt: undefined, source: "x", runtime: 4 },
    extensions: {},
    ...overrides,
  }) as unknown as ServicePlan;

describe("hasCustomImage", () => {
  it("Given a service with no image or build, When inspected, Then the image is the service type's own", () => {
    expect(hasCustomImage({} as ServiceConfig)).toBe(false);
  });

  it("Given a service with image:, When inspected, Then the image is custom", () => {
    expect(hasCustomImage({ image: "my/app:1" } as ServiceConfig)).toBe(true);
  });

  it("Given a Compose build block, When inspected, Then the image is custom", () => {
    expect(hasCustomImage({ build: { context: "." } } as unknown as ServiceConfig)).toBe(true);
  });

  it("Given Lando build steps, When inspected, Then the image is still the service type's own", () => {
    expect(hasCustomImage({ build: { artifact: ["echo hi"] } } as unknown as ServiceConfig)).toBe(false);
  });
});

describe("serviceHomeIntent", () => {
  it("Given a custom image, When the intent is built, Then the type's identity is dropped", () => {
    expect(intentFor({ image: "my/app:1" } as ServiceConfig).identity).toBeUndefined();
  });

  it("Given a planner-pinned catalog artifact tag, When the intent is built, Then the type's identity is kept", () => {
    // The planner writes the service type's own published image onto the config
    // as `image` before planning. That is Lando's image, not the author's, so it
    // must not look like a custom image.
    const intent = serviceHomeIntent({
      service: { image: "docker.io/lando/mariadb:10.6" } as ServiceConfig,
      serviceTypeId: "mariadb",
      identity,
      pinnedArtifactTag: "docker.io/lando/mariadb:10.6",
    });
    expect(intent.identity).toEqual(identity);
  });

  it("Given the type's own image, When the intent is built, Then the identity is kept", () => {
    expect(intentFor({} as ServiceConfig).identity).toEqual(identity);
  });
});

describe("resolveHomePath", () => {
  it("Given home: false, When resolved, Then no home is persisted", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({ home: false } as ServiceConfig),
      plannedUser: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("Given an explicit path, When resolved, Then it wins without consulting the identity", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({ home: { path: "/srv/home" } } as ServiceConfig, undefined),
      plannedUser: undefined,
    });
    expect(resolved).toBe("/srv/home");
  });

  it("Given no planned user, When resolved, Then the identity's default user selects the home", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({} as ServiceConfig),
      plannedUser: undefined,
    });
    expect(resolved).toBe("/home/node");
  });

  it("Given a planned user with a group, When resolved, Then only the principal selects the home", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({} as ServiceConfig),
      plannedUser: "root:wheel",
    });
    expect(resolved).toBe("/root");
  });

  it("Given a planned user the identity does not declare, When resolved, Then it refuses by tag", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({} as ServiceConfig),
      plannedUser: "nobody",
    });
    expect(resolved).toBeInstanceOf(HomePathCapabilityError);
    const failure = resolved as HomePathCapabilityError;
    expect(failure._tag).toBe("HomePathCapabilityError");
    expect(failure.service).toBe("web");
    expect(failure.user).toBe("nobody");
    expect(failure.remediation).toContain("services.web.home: false");
    expect(failure.remediation).toContain("services.web.home.path");
  });

  it("Given a custom image and no explicit path, When resolved, Then it refuses before any provider action", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({ image: "my/app:1" } as ServiceConfig),
      plannedUser: undefined,
    });
    expect(resolved).toBeInstanceOf(HomePathCapabilityError);
    expect((resolved as HomePathCapabilityError).serviceType).toBe("node:22");
  });

  it("Given a custom image and home: false, When resolved, Then nothing is persisted and nothing fails", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({ image: "my/app:1", home: false } as ServiceConfig),
      plannedUser: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("Given a custom image and an explicit path, When resolved, Then the authored path is used", () => {
    const resolved = resolveHomePath({
      serviceName: "web",
      intent: intentFor({ image: "my/app:1", home: { path: "/data/home" } } as ServiceConfig),
      plannedUser: undefined,
    });
    expect(resolved).toBe("/data/home");
  });
});

describe("applyServiceHome", () => {
  it("Given an enabled home, When applied, Then exactly one service-scoped store is added", () => {
    const result = applyServiceHome({
      servicePlan: planWith(),
      serviceName: "web",
      appSlug: "myapp",
      intent: intentFor({} as ServiceConfig),
    }) as ServicePlan;
    expect(result.storage).toEqual([
      { store: "lando-myapp-web-home", target: PortablePath.make("/home/node"), readOnly: false },
    ]);
  });

  it("Given the same plan twice, When applied, Then the generated store name is stable", () => {
    expect(homeStoreName("myapp", "web")).toBe("lando-myapp-web-home");
  });

  it("Given authored storage already at the home path, When applied, Then the authored mount is kept verbatim", () => {
    const authored = {
      store: "myapp-web-cache",
      target: PortablePath.make("/home/node"),
      readOnly: true,
    };
    const result = applyServiceHome({
      servicePlan: planWith({ storage: [authored] }),
      serviceName: "web",
      appSlug: "myapp",
      intent: intentFor({} as ServiceConfig),
    }) as ServicePlan;
    expect(result.storage).toEqual([authored]);
  });

  it("Given authored storage with a trailing slash, When applied, Then it is still the same destination", () => {
    const authored = {
      store: "myapp-web-cache",
      target: PortablePath.make("/home/node/"),
      readOnly: false,
    };
    const result = applyServiceHome({
      servicePlan: planWith({ storage: [authored] }),
      serviceName: "web",
      appSlug: "myapp",
      intent: intentFor({} as ServiceConfig),
    }) as ServicePlan;
    expect(result.storage).toHaveLength(1);
  });

  it("Given the planned user on the plan, When applied, Then that user's home is selected", () => {
    const result = applyServiceHome({
      servicePlan: planWith({ user: "root" }),
      serviceName: "web",
      appSlug: "myapp",
      intent: intentFor({} as ServiceConfig),
    }) as ServicePlan;
    expect(result.storage[0]?.target).toBe(PortablePath.make("/root"));
  });

  it("Given home: false, When applied, Then storage is untouched", () => {
    const result = applyServiceHome({
      servicePlan: planWith(),
      serviceName: "web",
      appSlug: "myapp",
      intent: intentFor({ home: false } as ServiceConfig),
    }) as ServicePlan;
    expect(result.storage).toEqual([]);
  });
});

describe("containerTargetKey", () => {
  it("Given a trailing slash, When keyed, Then it is ignored", () => {
    expect(containerTargetKey("/root/")).toBe("/root");
  });

  it("Given the filesystem root, When keyed, Then the slash is preserved", () => {
    expect(containerTargetKey("/")).toBe("/");
  });
});
