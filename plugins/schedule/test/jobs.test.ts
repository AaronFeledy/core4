import { describe, expect, test } from "bun:test";

import { ServiceName } from "@lando/sdk/schema";

import {
  findScheduleJob,
  jobsFromLandofile,
  scheduleSidecarGroups,
  scheduleSidecarName,
} from "../src/jobs.ts";

const job = (name: string, user?: string) => ({
  name,
  every: "@hourly",
  run: "true",
  ...(user === undefined ? {} : { user }),
});

const groupNames = (jobs: ReadonlyArray<{ readonly user?: string }>) =>
  scheduleSidecarGroups("web", jobs).map((group) => group.name);

describe("schedule sidecar groups", () => {
  test("a single job without a user keeps the plain sidecar name and no user override", () => {
    const groups = scheduleSidecarGroups("web", [job("tick")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("web-schedule");
    expect(groups[0]?.jobs).toEqual([job("tick")]);
    expect("user" in (groups[0] ?? {})).toBe(false);
  });

  test("the first job's group wins the plain name; later inherit groups use default", () => {
    expect(groupNames([job("tick"), job("other", "www-data")])).toEqual([
      "web-schedule",
      "web-schedule-www-data",
    ]);
    expect(groupNames([job("first", "www-data"), job("tick"), job("root", "root")])).toEqual([
      "web-schedule",
      "web-schedule-default",
      "web-schedule-root",
    ]);
  });

  test("jobs group by the exact authored user string", () => {
    const groups = scheduleSidecarGroups("web", [
      job("a", "www-data"),
      job("b", "www-data"),
      job("c", "www-data:staff"),
      job("d", "1001"),
      job("e", "1001:1001"),
    ]);
    expect(groups.map((group) => [group.name, group.user, group.jobs.map((entry) => entry.name)])).toEqual([
      ["web-schedule", "www-data", ["a", "b"]],
      ["web-schedule-www-data-staff", "www-data:staff", ["c"]],
      ["web-schedule-1001", "1001", ["d"]],
      ["web-schedule-1001-1001", "1001:1001", ["e"]],
    ]);
  });

  test("user slugs lowercase and collapse characters outside the allowlist", () => {
    expect(groupNames([job("tick"), job("upper", "WWW Data@Example")])).toEqual([
      "web-schedule",
      "web-schedule-www-data-example",
    ]);
    expect(groupNames([job("tick"), job("numeric", "1002")])).toEqual(["web-schedule", "web-schedule-1002"]);
  });

  test("the sidecar name helper stays the single derivation for the first group", () => {
    expect(scheduleSidecarName("web")).toBe("web-schedule");
    expect(scheduleSidecarGroups("web", [job("tick")])[0]?.name).toBe(scheduleSidecarName("web"));
  });
});

describe("schedule jobs", () => {
  test("reads jobs in order and inherits TZ from the parent service environment", () => {
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
        [ServiceName.make("db")]: { type: "compose" },
      },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.service).toBe("web");
    expect(jobs[0]?.timezone).toBe("Europe/Berlin");
    expect(jobs[1]?.user).toBe("www-data");
    expect(findScheduleJob(jobs, "tick").map((entry) => entry.name)).toEqual(["tick"]);
    expect(findScheduleJob(jobs, "missing")).toEqual([]);
  });

  test("strips the POSIX leading colon so the listed zone is the real zone name", () => {
    const jobs = jobsFromLandofile({
      services: {
        [ServiceName.make("web")]: {
          type: "compose",
          environment: { TZ: ":America/Chicago" },
          schedule: [{ name: "tick", every: "@hourly", run: "true" }],
        },
      },
    });
    expect(jobs[0]?.timezone).toBe("America/Chicago");
  });

  test("defaults the job timezone to UTC when the service sets no TZ", () => {
    const jobs = jobsFromLandofile({
      services: {
        [ServiceName.make("web")]: {
          type: "compose",
          schedule: [{ name: "tick", every: "@hourly", run: "true" }],
        },
      },
    });
    expect(jobs[0]?.timezone).toBe("UTC");
  });
});
