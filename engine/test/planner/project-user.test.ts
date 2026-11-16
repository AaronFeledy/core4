import { describe, expect, test } from "bun:test";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { CapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import { resolveProjectUser } from "../../src/planner/project-user.ts";

const baseCapabilities = buildProviderCapabilities({
  bindMounts: true,
  bindMountPerformance: "native",
  tlsCertificates: "lando",
  rootless: true,
  projectUserMapping: "userns-keep-id",
  bindOwnership: "root-is-host-user",
  composeSpec: "native",
  providerExtensions: [],
});

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...baseCapabilities,
  ...overrides,
});

const explanationOf = (resolved: ReturnType<typeof resolveProjectUser>) => {
  if (!("explanation" in resolved) || resolved.explanation === undefined)
    throw new Error("expected a project-user explanation");
  return resolved.explanation;
};

const phpIdentity: ServiceImageIdentity = {
  defaultUser: "root",
  homes: { root: "/root", "www-data": "/var/www" },
  projectUser: { name: "www-data", uid: 33, gid: 33 },
  preparedHomes: ["www-data"],
};

const input = (overrides: Record<string, unknown> = {}) => ({
  appKind: "user" as const,
  serviceName: "web",
  serviceTypeLabel: "php:8.3",
  appRoot: "/tmp/app",
  provider: ProviderId.make("lando"),
  capabilities: capabilities(),
  authored: undefined,
  authoredUser: undefined,
  appSourceMounted: true,
  identity: phpIdentity,
  ...overrides,
});

describe("resolveProjectUser grammar", () => {
  test("Given projectUser: false, Then the service opts out", () => {
    expect(resolveProjectUser(input({ authored: false }))).toEqual({
      explanation: {
        state: "opted-out",
        explicit: true,
        detail: "The Landofile explicitly opts this service out of a project user.",
      },
    });
  });

  test("Given a numeric uid:gid pair, Then both ids are kept", () => {
    expect(resolveProjectUser(input({ authored: "1000:1001" }))).toEqual({
      projectUser: { name: "1000", uid: 1000, gid: 1001 },
    });
  });

  test("Given the declared project-user name, Then the catalog identity is used", () => {
    expect(resolveProjectUser(input({ authored: "www-data" }))).toEqual({
      projectUser: { name: "www-data", uid: 33, gid: 33 },
    });
  });

  test("Given a bare uid, Then planning fails with the uid:gid remediation", () => {
    const resolved = resolveProjectUser(input({ authored: "1000" }));
    expect(resolved).toBeInstanceOf(LandofileValidationError);
    const error = resolved as LandofileValidationError;
    expect(error.message).toContain("unsupported value");
    expect(error.remediation).toContain("<uid>:<gid>");
    expect(error.issues[0]?.path).toEqual(["services", "web", "projectUser"]);
  });

  test.each(["name:group", "unknown", "www-data:www-data"])(
    "Given the unsupported value %s, Then planning fails",
    (authored) => {
      expect(resolveProjectUser(input({ authored }))).toBeInstanceOf(LandofileValidationError);
    },
  );

  test("Given a named value and no declared name, Then only numeric pairs are accepted", () => {
    const resolved = resolveProjectUser(input({ authored: "www-data", identity: undefined }));
    expect(resolved).toBeInstanceOf(LandofileValidationError);
    expect((resolved as LandofileValidationError).message).toContain("declares no project user name");
  });
});

describe("resolveProjectUser implicit resolution", () => {
  test("Given no authored project user, Then the catalog project user is used", () => {
    expect(resolveProjectUser(input())).toEqual({
      projectUser: { name: "www-data", uid: 33, gid: 33 },
    });
  });

  test("Given an authored numeric user, Then it wins over the catalog", () => {
    expect(resolveProjectUser(input({ authoredUser: "501:20" }))).toEqual({
      projectUser: { name: "501", uid: 501, gid: 20 },
    });
  });

  test("Given an authored user equal to the declared name, Then the catalog ids are used", () => {
    expect(resolveProjectUser(input({ authoredUser: "www-data" }))).toEqual({
      projectUser: { name: "www-data", uid: 33, gid: 33 },
    });
  });

  test("Given an authored root user, Then no project user is resolved", () => {
    const resolved = resolveProjectUser(input({ authoredUser: "root" }));
    expect(resolved).toEqual({
      explanation: {
        state: "unresolved",
        explicit: false,
        detail: "The service runs as root, and root processes keep their own identity.",
      },
    });
  });

  test("Given an authored non-root name that is not the catalog name, Then the catalog default still applies", () => {
    expect(resolveProjectUser(input({ authoredUser: "node" }))).toEqual({
      projectUser: { name: "www-data", uid: 33, gid: 33 },
    });
  });

  test("Given no identity and no numeric user, Then the absence is explained", () => {
    expect(explanationOf(resolveProjectUser(input({ identity: undefined }))).state).toBe("unresolved");
  });

  test.each(["root:root", "0:root", "root:0"])(
    "Given the authored root principal %s, Then no project user is resolved",
    (authoredUser) => {
      expect(explanationOf(resolveProjectUser(input({ authoredUser }))).state).toBe("unresolved");
    },
  );
});

describe("resolveProjectUser applicability", () => {
  test.each(["global", "scratch"] as const)("Given a %s app, Then it is not applicable", (appKind) => {
    expect(explanationOf(resolveProjectUser(input({ appKind }))).state).toBe("not-applicable");
  });

  test("Given a service without the app-source bind, Then it is not applicable", () => {
    expect(explanationOf(resolveProjectUser(input({ appSourceMounted: false }))).state).toBe(
      "not-applicable",
    );
  });

  test("Given an invalid explicit project user and no app-source mount, Then planning still fails", () => {
    const resolved = resolveProjectUser(input({ authored: "bogus", appSourceMounted: false }));
    expect(resolved).toBeInstanceOf(LandofileValidationError);
  });

  test("Given a valid explicit project user and no app-source mount, Then it is not applicable", () => {
    expect(
      explanationOf(resolveProjectUser(input({ authored: "www-data", appSourceMounted: false }))).state,
    ).toBe("not-applicable");
  });
});

describe("resolveProjectUser provider capability", () => {
  test("Given an implicit catalog default on an unsupported provider, Then planning succeeds with an explanation", () => {
    const resolved = resolveProjectUser(
      input({ capabilities: capabilities({ projectUserMapping: "unsupported" }) }),
    );
    expect(resolved).toEqual({
      explanation: {
        state: "provider-unsupported",
        explicit: false,
        detail:
          "Provider lando does not map one container id to the host user, so the service keeps the container default identity.",
      },
    });
  });

  test("Given an explicit project user on an unsupported provider, Then planning fails", () => {
    const resolved = resolveProjectUser(
      input({
        authored: "www-data",
        capabilities: capabilities({ projectUserMapping: "unsupported" }),
      }),
    );
    expect(resolved).toBeInstanceOf(CapabilityError);
    expect((resolved as CapabilityError).capability).toBe("projectUserMapping");
  });

  test("Given an explicit opt-out on an unsupported provider, Then no capability error is raised", () => {
    const resolved = resolveProjectUser(
      input({ authored: false, capabilities: capabilities({ projectUserMapping: "unsupported" }) }),
    );
    expect(resolved).toEqual({
      explanation: {
        state: "opted-out",
        explicit: true,
        detail: "The Landofile explicitly opts this service out of a project user.",
      },
    });
  });
});
