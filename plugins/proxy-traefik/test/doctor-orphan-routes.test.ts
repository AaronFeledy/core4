import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { globalAppRootPath } from "@lando/paths";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";

import {
  collectAppIdsFromAppliedState,
  makeOrphanRouteFilesCheck,
  orphanRouteFilesCheck,
} from "../src/doctor-orphan-routes.ts";
import { dynamicConfigDir } from "../src/proxy-paths.ts";

const platform: HostPlatform = "linux";

const doctorInput = (userDataRoot: string | undefined): PluginDoctorCheckInput => ({
  providerId: "lando",
  platform,
  env: {},
  userDataRoot,
  binDir: undefined,
  stateDir: undefined,
});

const withUserData = async <T>(run: (userDataRoot: string) => Promise<T>): Promise<T> => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-orphan-routes-"));
  try {
    return await run(userDataRoot);
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

describe("orphan route file doctor check", () => {
  test("flags a route file whose slug matches no known app", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicConfigDir({
        platform,
        globalAppRoot: globalAppRootPath(userDataRoot, platform),
      });
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "routes-gone.yml"), "http:\n  routers: {}\n", "utf8");
      await writeFile(join(directory, "routes-demo.yml"), "http:\n  routers: {}\n", "utf8");

      const reports = await Effect.runPromise(
        makeOrphanRouteFilesCheck(() => Effect.succeed(new Set(["demo"]))).run(doctorInput(userDataRoot)),
      );

      expect(reports).toHaveLength(1);
      expect(reports[0]?.name).toBe("orphan-route-files");
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.severity).toBe("warn");
      expect(reports[0]?.context.orphanCount).toBe("1");
      expect(reports[0]?.context.slugs).toBe("gone");
      expect(reports[0]?.solutions.every((solution) => solution.kind === "manual")).toBe(true);
      expect(JSON.stringify(reports[0])).not.toContain(userDataRoot);
    });
  });

  test("stays quiet when every route file matches a known app", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicConfigDir({
        platform,
        globalAppRoot: globalAppRootPath(userDataRoot, platform),
      });
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "routes-demo.yml"), "http:\n  routers: {}\n", "utf8");

      const reports = await Effect.runPromise(
        makeOrphanRouteFilesCheck(() => Effect.succeed(new Set(["demo"]))).run(doctorInput(userDataRoot)),
      );

      expect(reports).toEqual([]);
    });
  });

  test("reads known app ids from applied plan state", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicConfigDir({
        platform,
        globalAppRoot: globalAppRootPath(userDataRoot, platform),
      });
      const appliedDir = join(userDataRoot, "plugins", "@lando", "provider-lando", "applied-plans");
      await mkdir(directory, { recursive: true });
      await mkdir(appliedDir, { recursive: true });
      await writeFile(join(directory, "routes-kept.yml"), "http:\n  routers: {}\n", "utf8");
      await writeFile(join(directory, "routes-orphan.yml"), "http:\n  routers: {}\n", "utf8");
      await writeFile(
        join(appliedDir, "kept.json"),
        JSON.stringify({ version: 1, data: { id: "kept", name: "kept" } }),
        "utf8",
      );

      const reports = await Effect.runPromise(orphanRouteFilesCheck.run(doctorInput(userDataRoot)));

      expect(reports[0]?.context.slugs).toBe("orphan");
      expect(reports[0]?.context.orphanCount).toBe("1");
    });
  });

  test("collects ids from state-store envelopes and plan records", () => {
    expect(
      collectAppIdsFromAppliedState({
        version: 1,
        data: { id: "alpha" },
      }),
    ).toEqual(["alpha"]);
    expect(
      new Set(
        collectAppIdsFromAppliedState({
          version: 1,
          data: { beta: { id: "beta" }, gamma: { id: "gamma" } },
        }),
      ),
    ).toEqual(new Set(["beta", "gamma"]));
  });
});
