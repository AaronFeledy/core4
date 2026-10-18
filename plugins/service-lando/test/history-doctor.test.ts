import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { DoctorResourceInspector } from "@lando/sdk/plugins";
import { historyStoreName } from "@lando/sdk/schema";

import { historyDoctorCheck } from "../src/doctor/history.ts";
import { plugin } from "../src/index.ts";

const runHistoryCheck = (appName: string | undefined, resources?: DoctorResourceInspector) =>
  Effect.runPromise(
    historyDoctorCheck.run({
      providerId: "lando",
      platform: "linux",
      env: {},
      userDataRoot: undefined,
      binDir: undefined,
      stateDir: undefined,
      ...(appName === undefined ? {} : { app: { name: appName, root: "/tmp/histapp" } }),
      ...(resources === undefined ? {} : { resources }),
    }),
  );

describe("history doctor check", () => {
  test("is contributed by the service-lando plugin", () => {
    expect(plugin.doctorChecks).toEqual([historyDoctorCheck]);
  });

  test("is a no-op outside an app", async () => {
    expect(await runHistoryCheck(undefined)).toEqual([]);
  });

  test("reports unknown when no inspector is available", async () => {
    const [report] = await runHistoryCheck("histapp");
    expect(report).toMatchObject({
      name: "history",
      status: "pass",
      severity: "info",
      context: {
        volume: historyStoreName("histapp"),
        present: "unknown",
        detail: "no inspector",
      },
    });
  });

  test("reports present when the inspector lists the planned volume", async () => {
    const volume = historyStoreName("histapp");
    const [report] = await runHistoryCheck("histapp", {
      inspect: () =>
        Effect.succeed({
          status: "ok" as const,
          names: [volume],
          truncated: false,
        }),
    });
    expect(report?.context).toEqual({ volume, present: "true", detail: "present" });
  });

  test("reports absent when the planned volume is missing", async () => {
    const volume = historyStoreName("histapp");
    const [report] = await runHistoryCheck("histapp", {
      inspect: () =>
        Effect.succeed({
          status: "ok" as const,
          names: ["lando-histapp-data"],
          truncated: false,
        }),
    });
    expect(report?.context).toEqual({ volume, present: "false", detail: "absent" });
  });
});
