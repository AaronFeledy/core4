import { describe, expect, test } from "bun:test";
import type { AppFeatureContext, ClonedServiceRequest } from "@lando/sdk/services";
import { Effect } from "effect";

import { scheduleCompileFeature } from "../src/app-feature.ts";
import {
  SCHEDULE_TIMEZONE_STEP_ID,
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

const crontabScriptOf = async (
  environment?: AppFeatureContext["selected"][number]["normalizedConfig"]["environment"],
) => {
  const clones = await apply([
    view("web", {
      image: "php:8.3",
      ...(environment === undefined ? {} : { environment }),
      schedule: [job("tick", "@hourly", "true")],
    }),
  ]);
  const steps = clones[0]?.extraBuildSteps ?? [];
  const crontab = steps.find((step) => step.id === SUPERCRONIC_CRONTAB_STEP_ID);
  const timezone = steps.find((step) => step.id === SCHEDULE_TIMEZONE_STEP_ID);
  return {
    stepIds: steps.map((step) => step.id),
    buildKeyInputs: crontab?.buildKeyInputs,
    script: Array.isArray(crontab?.command) ? crontab.command.join("\n") : "",
    timezoneScript: Array.isArray(timezone?.command) ? timezone.command.join("\n") : undefined,
  };
};

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
    expect(inherit?.command[0]).toBe(SUPERCRONIC_BIN);
    expect(inherit?.command.at(-1)).toBe(SUPERCRONIC_CRONTAB);
    expect(inherit?.command, "a run must be skipped while the previous one is going").not.toContain(
      "-overlapping",
    );
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
      jobs: [{ name: "tick", schedule: "* * * * * * *", run: "true" }],
      timezone: "UTC",
    });
    expect(JSON.stringify(crontab?.command)).not.toContain("@every");
    expect(JSON.stringify(crontab?.command)).not.toContain("aptible/supercronic");
    const crontabScript = Array.isArray(crontab?.command) ? crontab.command.join("\n") : "";
    expect(crontabScript).toContain(`chmod 0644 ${SUPERCRONIC_CRONTAB}`);
    expect(crontabScript).toContain(`'${SUPERCRONIC_BIN}' -test`);
  });

  test("an inherit group keeps the plain sidecar name when an explicit user group comes first", async () => {
    const clones = await apply([
      view("web", {
        image: "alpine:3.22",
        schedule: [job("first", "@hourly", "true", "www-data"), job("inherit", "@daily", "true")],
      }),
    ]);
    expect(clones.map((clone) => clone.name)).toEqual(["web-schedule-www-data", "web-schedule"]);
    expect(clones[0]?.user).toBe("www-data");
    expect("user" in (clones[1] ?? {})).toBe(false);
  });

  test("no schedule means no clone", async () => {
    expect(await apply([view("web", { image: "alpine:3.22" })])).toEqual([]);
  });

  test.each([
    ["an unset TZ", undefined],
    ["TZ UTC", { TZ: "UTC" }],
  ] as const)("%s pins UTC on the crontab and needs no timezone-data step", async (_label, environment) => {
    const { buildKeyInputs, script, timezoneScript } = await crontabScriptOf(environment);
    expect(buildKeyInputs).toEqual({
      jobs: [{ name: "tick", schedule: "@hourly", run: "true" }],
      timezone: "UTC",
    });
    expect(script).toContain("'CRON_TZ=UTC'");
    expect(timezoneScript).toBeUndefined();
  });

  test.each(["America/Chicago", ":America/Chicago"] as const)(
    "TZ %s pins the stripped zone and makes its data loadable before the job table is built",
    async (tz) => {
      const { buildKeyInputs, script, stepIds, timezoneScript } = await crontabScriptOf({ TZ: tz });
      expect(buildKeyInputs).toEqual({
        jobs: [{ name: "tick", schedule: "@hourly", run: "true" }],
        timezone: "America/Chicago",
      });
      expect(script).toContain("'CRON_TZ=America/Chicago'");
      expect(stepIds).toEqual([SUPERCRONIC_STEP_ID, SCHEDULE_TIMEZONE_STEP_ID, SUPERCRONIC_CRONTAB_STEP_ID]);
      expect(timezoneScript).toContain("zone_file='/usr/share/zoneinfo/America/Chicago'");
    },
  );

  test("a non-string TZ descriptor cannot be honored, so the job zone is UTC", async () => {
    const { buildKeyInputs, script } = await crontabScriptOf({
      TZ: { _tag: "SecretRef", reference: "TZ" },
    });
    expect(buildKeyInputs).toEqual({
      jobs: [{ name: "tick", schedule: "@hourly", run: "true" }],
      timezone: "UTC",
    });
    expect(script).toContain("'CRON_TZ=UTC'");
  });

  test.each([
    "EST5EDT,M3.2.0,M11.1.0",
    "<+03>-3",
    "Europe/Berlin; touch /tmp/pwned",
    "$(touch /tmp/pwned)",
  ] as const)("the POSIX or unsafe TZ %s is refused before it can reach a path", async (tz) => {
    const { buildKeyInputs, script } = await crontabScriptOf({ TZ: tz });
    expect(buildKeyInputs).toEqual({
      jobs: [{ name: "tick", schedule: "@hourly", run: "true" }],
      timezone: tz,
    });
    expect(script).toContain("web");
    expect(script).toContain(tz);
    expect(script).toContain("exit 1");
    expect(
      script
        .split("'")
        .filter((_, index) => index % 2 === 0)
        .join(""),
    ).not.toContain(tz);
    expect(script).not.toContain("zoneinfo");
    expect(script).not.toContain("CRON_TZ=");
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
