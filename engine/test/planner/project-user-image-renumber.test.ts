import { describe, expect, test } from "bun:test";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { CapabilityError } from "@lando/sdk/errors";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import {
  projectUserRenumberStep,
  projectUserRenumberStepId,
  resolveProjectUser,
} from "../../src/planner/project-user.ts";

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...buildProviderCapabilities({
    bindMounts: true,
    bindMountPerformance: "native",
    tlsCertificates: "none",
    rootless: false,
    projectUserMapping: "image-renumber",
    bindOwnership: "host-ids",
    composeSpec: "native",
    providerExtensions: [],
  }),
  ...overrides,
});

const phpIdentity: ServiceImageIdentity = {
  defaultUser: "root",
  homes: { root: "/root", "www-data": "/var/www" },
  projectUser: { name: "www-data", uid: 33, gid: 33 },
  preparedHomes: ["www-data"],
};

const host = { uid: "1000", gid: "1000" };

const input = (overrides: Record<string, unknown> = {}) => ({
  appKind: "user" as const,
  serviceName: "web",
  serviceTypeLabel: "php:8.3",
  appRoot: "/tmp/app",
  provider: ProviderId.make("docker"),
  capabilities: capabilities(),
  authored: undefined,
  authoredUser: undefined,
  appSourceMounted: true,
  identity: phpIdentity,
  host,
  ...overrides,
});

describe("resolveProjectUser image renumbering", () => {
  test("an implicit catalog project user is renumbered to the host ids", () => {
    expect(resolveProjectUser(input())).toEqual({
      projectUser: { name: "www-data", uid: 1000, gid: 1000 },
    });
  });

  test("the declared name and its numeric ids both name the renumbered account", () => {
    const expected = {
      projectUser: { name: "www-data", uid: 1000, gid: 1000 },
    };
    expect(resolveProjectUser(input({ authored: "www-data" }))).toEqual(expected);
    expect(resolveProjectUser(input({ authored: "33:33" }))).toEqual(expected);
  });

  test("host ids that already match the catalog ids need no renumbering", () => {
    expect(resolveProjectUser(input({ host: { uid: "33", gid: "33" } }))).toEqual({
      projectUser: { name: "www-data", uid: 33, gid: 33 },
    });
  });

  test("a numeric project user other than the catalog account fails with remediation", () => {
    const resolved = resolveProjectUser(input({ authored: "1000:1001" }));
    expect(resolved).toBeInstanceOf(CapabilityError);
    const error = resolved as CapabilityError;
    expect(error.message).toContain("renumbers the catalog account www-data");
    expect(error.remediation).toContain("to false");
  });

  test.each([
    ["uid", { uid: "0", gid: "1000" }],
    ["gid", { uid: "1000", gid: "0" }],
  ])("host %s 0 fails planning with sudo remediation", (_id, rootHost) => {
    const resolved = resolveProjectUser(input({ host: rootHost }));
    expect(resolved).toBeInstanceOf(CapabilityError);
    const error = resolved as CapabilityError;
    expect(error.message).toContain("running with host");
    expect(error.remediation).toContain("sudo");
  });

  test("unreadable host ids explain instead of guessing", () => {
    const resolved = resolveProjectUser(input({ host: undefined }));
    expect(resolved).toEqual({
      explanation: {
        state: "provider-unsupported",
        explicit: false,
        detail: "Lando could not read this host's user ids, so the project user is not renumbered.",
      },
    });
  });

  test("a custom image's configured numeric user becomes the host ids", () => {
    expect(
      resolveProjectUser(input({ identity: undefined, authored: "100:100", authoredUser: "100:100" })),
    ).toEqual({
      projectUser: { name: "1000", uid: 1000, gid: 1000 },
    });
  });

  test("a custom image's numeric user is renumbered implicitly", () => {
    expect(resolveProjectUser(input({ identity: undefined, authoredUser: "100:100" }))).toEqual({
      projectUser: { name: "1000", uid: 1000, gid: 1000 },
    });
  });

  test("a custom image request for another identity fails with remediation", () => {
    const resolved = resolveProjectUser(
      input({ identity: undefined, authored: "100:100", authoredUser: "200:200" }),
    );
    expect(resolved).toBeInstanceOf(CapabilityError);
    const error = resolved as CapabilityError;
    expect(error.message).toContain("custom image");
    expect(error.remediation).toContain("services.web.user");
  });

  test("a custom image without a numeric configured user explains the absence", () => {
    const resolved = resolveProjectUser(input({ identity: undefined }));
    expect("explanation" in resolved ? resolved.explanation?.state : undefined).toBe("unresolved");
  });

  test("keep-id planning carries no mapping so its create stays a namespace mapping", () => {
    expect(
      resolveProjectUser(
        input({
          capabilities: capabilities({
            projectUserMapping: "userns-keep-id",
            bindOwnership: "root-is-host-user",
          }),
        }),
      ),
    ).toEqual({ projectUser: { name: "www-data", uid: 33, gid: 33 } });
  });
});

describe("projectUserRenumberStep", () => {
  const mapping = "image-renumber" as const;
  const realized = (uid: string, gid: string) => ({ name: "www-data", uid: Number(uid), gid: Number(gid) });

  test("renumbers the declared account and moves its files, never root-owned ones", () => {
    const step = projectUserRenumberStep({
      identity: phpIdentity,
      mapping,
      projectUser: realized(host.uid, host.gid),
      host,
    });
    expect(step?.id).toBe(projectUserRenumberStepId);
    expect(step?.phase).toBe("build");
    expect(step?.user).toBe("root");
    const command = JSON.stringify(step?.command);
    expect(command).toContain("usermod -o -u '1000'");
    expect(command).toContain("groupmod -o -g '1000'");
    expect(command).toContain("-uid 0");
    expect(command).toContain("chown -h '1000:1000'");
    expect(command).toContain("getent passwd '33'");
  });

  test("renumbers only the id that differs", () => {
    const step = projectUserRenumberStep({
      identity: phpIdentity,
      mapping,
      projectUser: realized("33", "1000"),
      host: { uid: "33", gid: "1000" },
    });
    const command = JSON.stringify(step?.command);
    expect(command).not.toContain("usermod -o -u");
    expect(command).toContain("usermod -g '1000'");
    expect(command).toContain("groupmod -o -g '1000'");
  });

  test("empties lastlog and faillog after usermod so a large host uid cannot grow them", () => {
    const step = projectUserRenumberStep({
      identity: phpIdentity,
      mapping,
      projectUser: realized("1500000", "1500000"),
      host: { uid: "1500000", gid: "1500000" },
    });
    const script = JSON.stringify(step?.command);
    const usermodAt = script.indexOf("usermod -o -u '1500000'");
    expect(usermodAt).toBeGreaterThanOrEqual(0);
    for (const file of ["/var/log/lastlog", "/var/log/faillog"]) {
      expect(script).toContain(`test ! -e '${file}' || : > '${file}'`);
      expect(script.indexOf(`: > '${file}'`)).toBeGreaterThan(usermodAt);
    }
  });

  test("skips an exact match and a custom image", () => {
    expect(
      projectUserRenumberStep({
        identity: phpIdentity,
        mapping,
        projectUser: realized("33", "33"),
        host: { uid: "33", gid: "33" },
      }),
    ).toBeUndefined();
    expect(
      projectUserRenumberStep({
        identity: undefined,
        mapping,
        projectUser: realized(host.uid, host.gid),
        host,
      }),
    ).toBeUndefined();
  });

  test("skips a service with no realized project user, such as projectUser: false", () => {
    expect(
      projectUserRenumberStep({
        identity: phpIdentity,
        mapping,
        projectUser: undefined,
        host,
      }),
    ).toBeUndefined();
  });

  test("skips a keep-id plan", () => {
    expect(
      projectUserRenumberStep({
        identity: phpIdentity,
        mapping: "userns-keep-id",
        projectUser: realized(host.uid, host.gid),
        host,
      }),
    ).toBeUndefined();
  });
});
