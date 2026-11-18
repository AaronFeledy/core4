import { describe, expect, test } from "bun:test";
import type { ServiceProjectUser, TmpfsMountPlan, VolumeMountPlan } from "@lando/sdk/schema";
import { PortablePath } from "@lando/sdk/schema";

import { projectUserTmpfsMounts, projectUserVolumeTrees } from "../../src/planner/project-user.ts";

const projectUser: ServiceProjectUser = { name: "www-data", uid: 33, gid: 33 };
const target = (path: string) => PortablePath.make(path);

const volume = (path: string, store: string, origin: "derived" | "service" = "derived"): VolumeMountPlan => ({
  type: "volume",
  store,
  target: target(path),
  readOnly: false,
  origin,
});

const tmpfs = (options?: string): TmpfsMountPlan => ({
  type: "tmpfs",
  target: target("/tmp"),
  readOnly: false,
  origin: "service",
  ...(options === undefined ? {} : { options }),
});

describe("projectUserVolumeTrees", () => {
  test("prepares a fresh derived volume for the project user ids", () => {
    expect(
      projectUserVolumeTrees({
        mounts: [volume("/var/lib/app", "lando-app--data")],
        projectUser,
      }),
    ).toEqual([{ target: "/var/lib/app", owner: "33:33" }]);
  });

  test("leaves the persisted home, authored storage, and binds alone while owning an empty shadow", () => {
    expect(
      projectUserVolumeTrees({
        mounts: [
          volume("/home/www-data", "lando-app--home"),
          volume("/app/vendor", "lando-app--shadow--vendor"),
          volume("/data", "lando-app--storage--data", "service"),
          {
            type: "bind",
            source: "/host",
            target: target("/app"),
            readOnly: false,
            origin: "service",
            realization: "passthrough",
          },
        ],
        projectUser,
        homeStore: "lando-app--home",
      }),
    ).toEqual([{ target: "/app/vendor", owner: "33:33" }]);
  });

  test("returns nothing without a realized project user", () => {
    expect(projectUserVolumeTrees({ mounts: [volume("/var/lib/app", "store")] })).toEqual([]);
  });
});

describe("projectUserTmpfsMounts", () => {
  test("adds ids and a writable mode to a tmpfs mount", () => {
    const expected: TmpfsMountPlan = {
      ...tmpfs(),
      options: "size=64m,uid=33,gid=33,mode=0770",
    };
    expect(projectUserTmpfsMounts([tmpfs("size=64m")], projectUser)).toEqual([expected]);
  });

  test("preserves authored uid, gid, and mode options", () => {
    const expected: TmpfsMountPlan = { ...tmpfs(), options: "uid=0,gid=0,mode=1777" };
    expect(projectUserTmpfsMounts([tmpfs("uid=0,gid=0,mode=1777")], projectUser)).toEqual([expected]);
  });

  test("does not touch mounts without a project user", () => {
    const mounts = [tmpfs()];
    expect(projectUserTmpfsMounts(mounts, undefined)).toEqual(mounts);
  });
});
