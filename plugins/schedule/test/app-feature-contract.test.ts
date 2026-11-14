import { describe, expect, test } from "bun:test";
import type { ScheduleJob } from "@lando/sdk/schema";
import type { ClonedServiceRequest } from "@lando/sdk/services";
import { runAppFeatureContract } from "@lando/sdk/test";
import { Effect } from "effect";

import { scheduleCompileFeature } from "../src/app-feature.ts";

describe("schedule catalog × app-feature contract suite", () => {
  test("schedule.compile clones one sidecar per user group", async () => {
    // Given
    const jobs: ScheduleJob[] = [
      { name: "tick", every: "@hourly", run: "true" },
      { name: "other", every: "@daily", run: "true", user: "1002" },
    ];
    const recorded: Array<ClonedServiceRequest> = [];

    // When
    const result = await Effect.runPromise(
      runAppFeatureContract({
        feature: scheduleCompileFeature,
        services: [
          { serviceName: "web", serviceType: "php", normalizedConfig: { schedule: jobs } },
          { serviceName: "db", serviceType: "mariadb" },
        ],
        onRecordedClones: (clones) => recorded.push(...clones),
      }),
    );

    // Then
    expect(result).toBeUndefined();
    expect(recorded.map(({ from, name, user }) => ({ from, name, user }))).toEqual([
      { from: "web", name: "web-schedule", user: undefined },
      { from: "web", name: "web-schedule-1002", user: "1002" },
    ]);
  });

  test("an app with no scheduled service queues no clone", async () => {
    // Given a selected service with no schedule. schedule.compile only mutates by
    // cloning, so the contract's no-op path is the only legal shape for this app.
    const recorded: Array<ClonedServiceRequest> = [];

    // When / Then
    await expect(
      Effect.runPromise(
        runAppFeatureContract({
          feature: scheduleCompileFeature,
          services: [{ serviceName: "web", serviceType: "php" }],
          expectNoActivation: true,
          onRecordedClones: (clones) => recorded.push(...clones),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
  });
});
