import { describe, expect, test } from "bun:test";
import type { BindMountPlan, ServiceProjectUser, TmpfsMountPlan, VolumeMountPlan } from "@lando/sdk/schema";
import { PortablePath } from "@lando/sdk/schema";

import { dataTreeOwnershipStep, projectUserVolumeTrees } from "../../src/planner/data-tree.ts";
import { projectUserTmpfsMounts } from "../../src/planner/project-user.ts";

const projectUser: ServiceProjectUser = { name: "www-data", uid: 33, gid: 33 };
const target = (path: string) => PortablePath.make(path);

const volume = (
  path: string,
  store: string,
  origin: "derived" | "authored" = "derived",
): VolumeMountPlan => ({
  type: "volume",
  store,
  target: target(path),
  readOnly: false,
  origin,
});

const bind = (path: string, role?: "app"): BindMountPlan => ({
  type: "bind",
  source: "/host",
  target: target(path),
  readOnly: false,
  realization: "passthrough",
  ...(role === undefined ? {} : { role }),
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
    const trees = projectUserVolumeTrees({
      mounts: [
        volume("/home/www-data", "lando-app--home"),
        volume("/app/vendor", "lando-app--shadow--vendor"),
        volume("/data", "lando-app--storage--data", "authored"),
        bind("/app", "app"),
        bind("/data/local/source"),
      ],
      projectUser,
      homeStore: "lando-app--home",
    });
    expect(dataTreeOwnershipStep(trees)?.command).toEqual([
      "sh",
      "-c",
      "set -eu; mkdir -p '/app/vendor'; chown -R '33:33' '/app/vendor'; chmod 0770 '/app/vendor'",
    ]);
  });

  test.each(["/app/./", "/application/project", "/app/../outside/project"])(
    "does not own authored /app when app bind %s is not strictly inside it",
    (appTarget) => {
      expect(
        projectUserVolumeTrees({
          mounts: [volume("/app", "store", "authored"), bind(appTarget, "app")],
          projectUser,
        }),
      ).toEqual([]);
    },
  );

  test("creates only normalized, contained mount parents before chowning a derived tree", () => {
    const trees = projectUserVolumeTrees({
      mounts: [
        volume("/app/vendor", "shadow"),
        bind("/app/vendor/./acme/old/../config.ini"),
        bind("/app/vendor/acme/other.ini"),
        bind("/app/vendor/../outside/dir/config.ini"),
        { ...tmpfs(), target: target("/app/vendor/build's cache/tmp") },
        volume("/app/vendor/another/cache", "cache", "authored"),
      ],
      projectUser,
    });
    expect(dataTreeOwnershipStep(trees)?.command).toEqual([
      "sh",
      "-c",
      "set -eu; mkdir -p '/app/vendor' '/app/vendor/acme' '/app/vendor/build'\\''s cache' '/app/vendor/another'; chown -R '33:33' '/app/vendor'; chmod 0770 '/app/vendor'",
    ]);
  });

  test("emits no ownership step for enclosing storage without a realized project user", () => {
    const trees = projectUserVolumeTrees({
      mounts: [volume("/app", "store", "authored"), bind("/app/web/main", "app")],
    });
    expect(dataTreeOwnershipStep(trees)).toBeUndefined();
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
