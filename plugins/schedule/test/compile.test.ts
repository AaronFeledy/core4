import { describe, expect, test } from "bun:test";
import type { AppFeatureContext, ClonedServiceRequest } from "@lando/sdk/services";
import { Effect } from "effect";

import { scheduleCompileFeature } from "../src/app-feature.ts";
import {
  SUPERCRONIC_ARTIFACTS,
  SUPERCRONIC_BIN,
  SUPERCRONIC_CRONTAB,
  SUPERCRONIC_CRONTAB_STEP_ID,
  SUPERCRONIC_STEP_ID,
} from "../src/supercronic.ts";

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

const job = (name: string, every: string, run: string, user?: string) => ({
  name,
  every,
  run,
  ...(user === undefined ? {} : { user }),
});

describe("schedule compile feature", () => {
  test("splits one parent into user sidecars with separate binary and crontab build steps", async () => {
    const clones = await apply([
      view("web", {
        image: "php:8.3",
        user: "1001",
        environment: { TZ: "UTC", DB_HOST: "db" },
        schedule: [
          job("tick", "@every 1s", "true"),
          job("other", "@every 5m", "touch /app/other", "1002"),
          job("named", "@hourly", "echo named", "nobody"),
        ],
      }),
      view("db", { image: "mariadb:11", appMount: false }),
    ]);

    expect(clones.map((clone) => clone.name)).toEqual([
      "web-schedule",
      "web-schedule-1002",
      "web-schedule-nobody",
    ]);
    expect(clones.map((clone) => clone.user)).toEqual([undefined, "1002", "nobody"]);
    expect("user" in (clones[0] ?? {})).toBe(false);

    const inherit = clones[0];
    expect(inherit?.from).toBe("web");
    expect(inherit?.command).toEqual([SUPERCRONIC_BIN, "-overlapping", SUPERCRONIC_CRONTAB]);
    expect(inherit?.omitConfigKeys).toEqual(["schedule"]);

    const steps = inherit?.extraBuildSteps ?? [];
    expect(steps.map((step) => step.id)).toEqual([SUPERCRONIC_STEP_ID, SUPERCRONIC_CRONTAB_STEP_ID]);
    expect(steps.every((step) => step.phase === "build")).toBe(true);
    expect(steps.every((step) => step.user === "root")).toBe(true);

    const [binary, crontab] = steps;
    expect(binary?.buildKeyInputs).toMatchObject({ supercronic: { version: expect.any(String) } });
    expect(JSON.stringify(binary?.command)).toContain(SUPERCRONIC_ARTIFACTS.amd64.sha256);
    expect(JSON.stringify(binary?.command)).not.toContain("setpriv");
    expect(crontab?.buildKeyInputs).toEqual({
      crontab: ["* * * * * * * true"],
    });
    expect(JSON.stringify(crontab?.command)).not.toContain("@every");
    expect(JSON.stringify(crontab?.command)).not.toContain("aptible/supercronic");
    const crontabScript = Array.isArray(crontab?.command) ? crontab.command.join("\n") : "";
    expect(crontabScript).toContain(`chmod 0644 ${SUPERCRONIC_CRONTAB}`);
  });

  test("a later group carries no user when the first group is an explicit user", async () => {
    const clones = await apply([
      view("web", {
        image: "alpine:3.22",
        schedule: [job("first", "@hourly", "true", "www-data"), job("inherit", "@daily", "true")],
      }),
    ]);
    expect(clones.map((clone) => clone.name)).toEqual(["web-schedule", "web-schedule-default"]);
    expect(clones[0]?.user).toBe("www-data");
    expect("user" in (clones[1] ?? {})).toBe(false);
  });

  test("no schedule means no clone", async () => {
    expect(await apply([view("web", { image: "alpine:3.22" })])).toEqual([]);
  });

  test("does not pre-check image shells; the planner owns the unsupported-image error", async () => {
    const clones = await apply([
      view("web", {
        image: "gcr.io/distroless/static",
        schedule: [job("tick", "@hourly", "true")],
      }),
    ]);
    expect(clones.map((clone) => clone.name)).toEqual(["web-schedule"]);
  });
});
