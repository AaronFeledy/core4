import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  projectUserNumericCreateUser,
} from "../src/plan.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-15T00:00:00Z"),
  source: "project-user",
  runtime: 4 as const,
};

const baseService: ServicePlan = {
  name: ServiceName.make("web"),
  type: "php:8.3",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "php:8.3-apache-bookworm" },
  environment: {},
  home: { state: "persisted", target: "/var/www", store: "lando-app--home", user: "www-data" },
  mounts: [],
  endpoints: [],
  hostAliases: [],
  routes: [],
  dependsOn: [],
  metadata,
  extensions: {},
};

const service = (overrides: Partial<Pick<ServicePlan, "projectUser" | "user">> = {}): ServicePlan => ({
  ...baseService,
  ...overrides,
});

const plan = (value: ServicePlan): AppPlan => ({
  valueModel: 1,
  id: AppId.make("project-user"),
  name: "Project User",
  slug: "project-user",
  root: AbsolutePath.make("/tmp/project-user"),
  provider: value.provider,
  services: { [value.name]: value },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  networking: landoNetworkingPlan({
    slug: "project-user",
    serviceNames: [value.name],
    sharedCrossAppNetwork: true,
  }),
  extensions: {},
});

describe("project-user container creation", () => {
  const projectUser = { name: "www-data", uid: 33, gid: 33 };

  test("Given a realized project user, Then HostConfig maps that id with keep-id", () => {
    const config = containerHostConfigFragment(plan(service({ projectUser })), service({ projectUser }));
    expect(config.UsernsMode).toBe("keep-id:uid=33,gid=33");
  });

  test("Given no project user, Then no user namespace is requested", () => {
    expect(containerHostConfigFragment(plan(service()), service())).not.toHaveProperty("UsernsMode");
  });

  test("Given an explicit create user, Then it overrides the authored process user", () => {
    const value = service({ projectUser, user: "root" });
    const body = containerCreateBodyFragment(plan(value), value, { createUser: "node" });
    expect(body.User).toBe("node");
  });

  test("Given a project user and an inspected image user, Then the image user is preserved", () => {
    const value = service({ projectUser });
    const body = containerCreateBodyFragment(plan(value), value, { createUser: "node" });
    expect(body.User).toBe("node");
  });

  test("Given no process user, Then the create body omits User", () => {
    const body = containerCreateBodyFragment(plan(service()), service());
    expect(body).not.toHaveProperty("User");
  });

  test("The mapping is part of the create fingerprint", () => {
    const without = commonContainerLabels(plan(service()), service())[CREATE_CONFIG_LABEL];
    const withMapping = commonContainerLabels(plan(service({ projectUser })), service({ projectUser }))[
      CREATE_CONFIG_LABEL
    ];
    const changedIds = commonContainerLabels(
      plan(service({ projectUser: { name: "www-data", uid: 34, gid: 34 } })),
      service({ projectUser: { name: "www-data", uid: 34, gid: 34 } }),
    )[CREATE_CONFIG_LABEL];
    expect(withMapping).not.toBe(without);
    expect(changedIds).not.toBe(withMapping);
  });
});

describe("image-renumber container creation", () => {
  const withMapping = (value: ServicePlan): ServicePlan => ({
    ...value,
    extensions: { ...value.extensions, "@lando/core/project-user-mapping": "image-renumber" },
  });
  const renumbered = withMapping(service({ projectUser: { name: "www-data", uid: 1000, gid: 1000 } }));

  test("Given an image-renumber plan, Then no user namespace is requested", () => {
    expect(containerHostConfigFragment(plan(renumbered), renumbered)).not.toHaveProperty("UsernsMode");
  });

  test("Given a numeric renumbered identity, Then the create user is the host id pair", () => {
    expect(
      projectUserNumericCreateUser(
        withMapping(service({ projectUser: { name: "1000", uid: 1000, gid: 1000 } })),
      ),
    ).toBe("1000:1000");
    expect(projectUserNumericCreateUser(renumbered)).toBeUndefined();
    expect(
      projectUserNumericCreateUser(service({ projectUser: { name: "www-data", uid: 33, gid: 33 } })),
    ).toBeUndefined();
  });

  test("Given a numeric renumbered identity, Then the create body names it explicitly", () => {
    const value = withMapping(service({ projectUser: { name: "1000", uid: 1000, gid: 1000 } }));
    const body = containerCreateBodyFragment(plan(value), value, { createUser: "1000:1000" });
    expect(body.User).toBe("1000:1000");
  });

  test("The realization is part of the create fingerprint", () => {
    const keepId = { name: "www-data", uid: 1000, gid: 1000 };
    const namespaced = commonContainerLabels(
      plan(service({ projectUser: keepId })),
      service({ projectUser: keepId }),
    )[CREATE_CONFIG_LABEL];
    const renamed = commonContainerLabels(plan(renumbered), renumbered)[CREATE_CONFIG_LABEL];
    expect(renamed).not.toBe(namespaced);
  });
});
