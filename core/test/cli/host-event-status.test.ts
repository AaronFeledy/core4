import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileEffectiveEvents,
  hostEventStatusesForApp,
  planServicePrimary,
  stampPlanServices,
} from "@lando/engine/planner/effective-events";
import { makeLandoPaths } from "@lando/paths";

import { hostEventStatusesForPlan } from "../../src/cli/commands/host-event-status.ts";

const previous = new Map<string, string>();

beforeEach(() => {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LANDO_") && value !== undefined) {
      previous.set(key, value);
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("LANDO_")) delete process.env[key];
  for (const [key, value] of previous) process.env[key] = value;
  previous.clear();
});

const withConfRoot = async (write: (dir: string) => Promise<void>, run: () => void | Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-host-event-status-"));
  process.env.LANDO_USER_CONF_ROOT = dir;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
  process.env.LANDO_USER_CACHE_ROOT = join(dir, "cache");
  try {
    await write(dir);
    await run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("hostEventStatusesForPlan", () => {
  test("uses landofile services including an explicit primary", async () => {
    await withConfRoot(
      (dir) =>
        writeFile(
          join(dir, "config.yml"),
          "hostEvents:\n  post-start:\n    - echo web\n    - cmd: echo db\n      service: db\n",
        ),
      () => {
        const statuses = hostEventStatusesForPlan({
          name: "site",
          root: "/apps/site",
          services: { web: { primary: true }, db: {} },
        });
        expect(statuses.map((entry) => [entry.step, entry.status])).toEqual([
          ["echo web", "active"],
          [{ cmd: "echo db", service: "db" }, "active"],
        ]);
      },
    );
  });

  test("honors the global and scratch exclusion", async () => {
    await withConfRoot(
      (dir) =>
        writeFile(
          join(dir, "config.yml"),
          'hostEvents:\n  pre-start:\n    - cmd: echo host\n      service: ":host"\n',
        ),
      () => {
        const paths = makeLandoPaths();
        expect(
          hostEventStatusesForPlan({
            name: "global",
            root: "/apps/site",
            services: { web: { primary: true } },
          }),
        ).toEqual([]);
        expect(
          hostEventStatusesForPlan({
            name: "site",
            root: paths.globalAppRoot,
            services: { web: { primary: true } },
          }),
        ).toEqual([]);
        expect(
          hostEventStatusesForPlan({
            name: "scratch",
            root: join(paths.scratchDir, "work"),
            services: { web: { primary: true } },
          }),
        ).toEqual([]);
      },
    );
  });

  test("treats an implicit web service as the planner primary", async () => {
    await withConfRoot(
      (dir) => writeFile(join(dir, "config.yml"), "hostEvents:\n  post-start:\n    - echo web\n"),
      () => {
        const hostEvents = { "post-start": ["echo web"] };
        const authored = { web: {} };
        const runtime = compileEffectiveEvents({
          landofile: {},
          hostEvents,
          services: stampPlanServices(authored),
        });
        const statuses = hostEventStatusesForPlan({
          name: "site",
          root: "/apps/site",
          services: authored,
        });
        expect(planServicePrimary("web", undefined)).toBe(true);
        expect(statuses).toEqual(hostEventStatusesForApp(runtime));
        expect(statuses.map((entry) => [entry.step, entry.status])).toEqual([["echo web", "active"]]);
      },
    );
  });

  test("does not treat a lamp recipe as adding a primary when the landofile has none", async () => {
    await withConfRoot(
      (dir) => writeFile(join(dir, "config.yml"), "hostEvents:\n  post-start:\n    - echo web\n"),
      () => {
        const hostEvents = { "post-start": ["echo web"] };
        const services = { php: { primary: false } };
        const runtime = compileEffectiveEvents({
          landofile: {},
          hostEvents,
          services: stampPlanServices(services),
        });
        const statuses = hostEventStatusesForPlan({
          name: "site",
          root: "/apps/site",
          services,
        });
        expect(statuses).toEqual(hostEventStatusesForApp(runtime));
        expect(statuses).toEqual([
          {
            event: "post-start",
            index: 0,
            step: "echo web",
            status: "skipped",
            reason: "no primary service",
          },
        ]);
      },
    );
  });

  test("surfaces a config.yml hostEvents load error", async () => {
    await withConfRoot(
      (dir) => writeFile(join(dir, "config.yml"), "hostEvents:\n  pre-start:\n    - echo container\n"),
      () => {
        expect(() =>
          hostEventStatusesForPlan({
            name: "site",
            root: "/apps/site",
            services: { web: { primary: true } },
          }),
        ).toThrow(/config\.yml hostEvents\.pre-start\[0\]/);
      },
    );
  });
});
