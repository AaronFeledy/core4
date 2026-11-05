import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppFeatureCloneError } from "@lando/sdk/errors";
import type { AppFeatureContext, ClonedServiceRequest } from "@lando/sdk/services";

import { scheduleCompileFeature } from "../src/app-feature.ts";
import { SUPERCRONIC_BIN, SUPERCRONIC_STEP_ID } from "../src/supercronic.ts";

const view = (name: string, config: AppFeatureContext["selected"][number]["normalizedConfig"]) => ({
  serviceName: name,
  serviceType: "compose",
  base: "l337" as const,
  primary: name === "web",
  featureIds: [],
  normalizedConfig: config,
});

const apply = async (services: ReadonlyArray<AppFeatureContext["selected"][number]>) => {
  const clones: ClonedServiceRequest[] = [];
  const ctx: AppFeatureContext = {
    featureId: scheduleCompileFeature.id,
    appRoot: "/tmp/schedule-compile",
    config: {},
    selected: services,
    forEachSelected: () => undefined,
    select: () => undefined,
    addClonedService: (request) => {
      clones.push(request);
    },
  };
  await Effect.runPromise(scheduleCompileFeature.apply(ctx));
  return clones;
};

describe("schedule compile feature", () => {
  test("clones each scheduled parent into a sidecar with a pinned scheduler install", async () => {
    const clones = await apply([
      view("web", {
        image: "alpine:3.22",
        user: "1001",
        environment: { TZ: "UTC", DB_HOST: "db" },
        schedule: [{ name: "tick", every: "@every 1s", run: "true" }],
      }),
      view("db", { image: "mariadb:11", appMount: false }),
    ]);
    expect(clones).toHaveLength(1);
    expect(clones[0]?.from).toBe("web");
    expect(clones[0]?.name).toBe("web-schedule");
    expect(clones[0]?.command).toEqual([SUPERCRONIC_BIN, "-overlapping", expect.any(String)]);
    expect(clones[0]?.omitConfigKeys).toEqual(["schedule"]);
    expect(clones[0]?.user).toBe("root");
    expect(clones[0]?.extraBuildSteps?.[0]?.id).toBe(SUPERCRONIC_STEP_ID);
    expect(clones[0]?.extraBuildSteps?.[0]?.user).toBe("root");
    expect(JSON.stringify(clones[0]?.extraBuildSteps?.[0]?.buildKeyInputs)).toContain("0.2.51");
    expect(JSON.stringify(clones[0]?.extraBuildSteps)).toContain("* * * * * * *");
    expect(JSON.stringify(clones[0]?.extraBuildSteps)).not.toContain("@every");
  });

  test("fails at plan time when the parent image has no shell", async () => {
    const ctx: AppFeatureContext = {
      featureId: scheduleCompileFeature.id,
      appRoot: "/tmp/schedule-distroless",
      config: {},
      selected: [
        view("web", {
          image: "gcr.io/distroless/static",
          schedule: [{ name: "tick", every: "@hourly", run: "true" }],
        }),
      ],
      forEachSelected: () => undefined,
      select: () => undefined,
      addClonedService: () => {
        throw new Error("must not clone a distroless parent");
      },
    };
    await expect(Effect.runPromise(scheduleCompileFeature.apply(ctx))).rejects.toBeInstanceOf(
      AppFeatureCloneError,
    );
  });
});
