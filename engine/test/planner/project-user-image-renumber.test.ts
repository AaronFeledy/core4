import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { CapabilityError } from "@lando/sdk/errors";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import {
  type ResolveProjectUserInput,
  projectUserRenumberStep,
  projectUserRenumberStepId,
  resolveProjectUser,
} from "../../src/planner/project-user.ts";

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...buildProviderCapabilities({
    bindMounts: true,
    serviceHealth: "native",
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

const input = (overrides: Partial<ResolveProjectUserInput> = {}): ResolveProjectUserInput => ({
  appKind: "user",
  serviceName: "web",
  serviceTypeLabel: "php:8.3",
  appRoot: "/tmp/app",
  provider: ProviderId.make("docker"),
  capabilities: capabilities(),
  authored: undefined,
  authoredUser: undefined,
  authoredLauncher: false,
  processUser: undefined,
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
  ])("host %s 0 fails planning with sudo remediation", (id, rootHost) => {
    const resolved = resolveProjectUser(input({ host: rootHost }));
    expect(resolved).toBeInstanceOf(CapabilityError);
    const error = resolved as CapabilityError;
    expect(error.message).toContain(`running with host ${id} 0`);
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

describe("image renumbering with a launcher-scoped account", () => {
  const identity = {
    defaultUser: "root",
    homes: { root: "/root" },
    projectUser: { name: "worker", uid: 120, gid: 121 },
    projectUserDefault: "launcher",
  } satisfies ServiceImageIdentity;

  test.each([
    ["generated launcher", {}, 1000, 1000],
    ["generated launcher with a named process user", { authoredUser: "worker" }, 1000, 1000],
    [
      "numeric process already running as the host ids",
      { authoredUser: "120:121", host: { uid: "120", gid: "121" } },
      120,
      121,
    ],
    [
      "explicit name on a replacement launcher",
      { authored: "worker", authoredLauncher: true, authoredUser: "120:121" },
      1000,
      1000,
    ],
    ["explicit pair on a replacement launcher", { authored: "120:121", authoredLauncher: true }, 1000, 1000],
  ] satisfies ReadonlyArray<readonly [string, Partial<ResolveProjectUserInput>, number, number]>)(
    "maps the account for %s",
    (_label, overrides, uid, gid) => {
      expect(resolveProjectUser(input({ identity, ...overrides }))).toEqual({
        projectUser: { name: "worker", uid, gid },
      });
    },
  );

  test.each([
    ["numeric user whose process would keep its old ids", { authoredUser: "120:121" }],
    [
      "numeric user where just the group would change",
      { authoredUser: "120:121", host: { uid: "120", gid: "1000" } },
    ],
    ["different numeric user even if it matches the host ids", { authoredUser: "1000:1000" }],
    [
      "different effective process user despite matching authored and host ids",
      { authoredUser: "120:121", processUser: "other", host: { uid: "120", gid: "121" } },
    ],
    [
      "replacement launcher with the worker pair",
      { authoredLauncher: true, authoredUser: "120:121", host: { uid: "120", gid: "121" } },
    ],
    ["replacement launcher with an unrelated pair", { authoredLauncher: true, authoredUser: "1000:1000" }],
  ] satisfies ReadonlyArray<readonly [string, Partial<ResolveProjectUserInput>]>)(
    "does not renumber the account for %s",
    (_label, overrides) => {
      const result = resolveProjectUser(input({ identity, ...overrides }));
      expect("explanation" in result ? result.explanation?.state : undefined).toBe("provider-unsupported");
    },
  );

  test.each(["uid", "gid"] as const)("skips the default when host %s is zero", (id) => {
    const result = resolveProjectUser(input({ identity, host: { ...host, [id]: "0" } }));
    expect(result).toEqual({
      explanation: { state: "provider-unsupported", explicit: false, detail: expect.any(String) },
    });
  });

  test.each([
    ["named projectUser", { authored: "worker" }],
    ["numeric projectUser", { authored: "120:121" }],
    ["eligible numeric process user", { authoredUser: "120:121" }],
  ] satisfies ReadonlyArray<readonly [string, Partial<ResolveProjectUserInput>]>)(
    "still refuses %s when renumbering would use host root",
    (_label, overrides) => {
      expect(
        resolveProjectUser(input({ identity, host: { ...host, uid: "0" }, ...overrides })),
      ).toBeInstanceOf(CapabilityError);
    },
  );
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
    expect(command).toContain("! -user 0");
    expect(command).toContain("chown -h '1000:1000'");
    expect(command).toContain("getent passwd '33'");
  });

  test.skipIf(process.platform === "win32")(
    "renumbers local account records without shadow-utils, including a target-id collision",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lando-local-ids-"));
      const passwd = join(dir, "passwd");
      const group = join(dir, "group");
      try {
        for (const name of ["awk", "cat", "find", "mktemp", "rm"]) {
          const executable = Bun.which(name);
          if (!executable) throw new TypeError(`Missing test command ${name}`);
          await symlink(executable, join(dir, name));
        }
        await Bun.write(
          passwd,
          "root:x:0:0::/root:/bin/sh\nweb:x:33:33::/srv:/bin/sh\nother:x:1000:1000::/home/other:/bin/sh\n",
        );
        await Bun.write(group, "root:x:0:\nweb:x:33:web\nother:x:1000:\n");
        const step = projectUserRenumberStep({
          identity: phpIdentity,
          mapping,
          projectUser: realized(host.uid, host.gid),
          host,
        });
        const command = step?.command;
        if (!Array.isArray(command) || typeof command[2] !== "string")
          throw new TypeError("Expected renumber shell command");
        const script = command[2]
          .replaceAll("/etc/passwd", '"$1/passwd"')
          .replaceAll("/etc/group", '"$1/group"')
          .replace("find / -xdev", 'find "$1" -xdev');
        const proc = Bun.spawnSync(["/bin/sh", "-c", script, "sh", dir], { env: { PATH: dir } });
        expect(proc.exitCode, proc.stderr.toString()).toBe(0);
        expect(await Bun.file(passwd).text()).toBe(
          "root:x:0:0::/root:/bin/sh\nweb:x:1000:1000::/srv:/bin/sh\nother:x:1000:1000::/home/other:/bin/sh\n",
        );
        expect(await Bun.file(group).text()).toBe("root:x:0:\nweb:x:1000:web\nother:x:1000:\n");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

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
