import { describe, expect, test } from "bun:test";

import { ServiceName } from "@lando/sdk/schema";

import { findScheduleJob, jobsFromLandofile, scheduleSidecarName } from "../src/jobs.ts";

describe("schedule jobs", () => {
  test("reads unique jobs and inherits TZ from the parent environment", () => {
    const jobs = jobsFromLandofile({
      name: "demo",
      services: {
        [ServiceName.make("web")]: {
          type: "compose",
          environment: { TZ: "Europe/Berlin" },
          schedule: [
            { name: "tick", every: "@hourly", run: "true" },
            { name: "other", every: "@daily", run: ["echo", "ok"], user: "www-data" },
          ],
        },
        [ServiceName.make("db")]: { type: "mariadb" },
      },
    });
    expect(scheduleSidecarName("web")).toBe("web-schedule");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.timezone).toBe("Europe/Berlin");
    expect(jobs[1]?.user).toBe("www-data");
    expect(findScheduleJob(jobs, "tick")).toEqual(jobs[0] === undefined ? [] : [jobs[0]]);
    expect(findScheduleJob(jobs, "missing")).toEqual([]);
  });
});
