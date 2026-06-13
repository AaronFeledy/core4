import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { LandoCommandError } from "@lando/sdk/errors";
import { Telemetry } from "@lando/sdk/services";
import { update } from "../../src/cli/commands/update.ts";
import {
  TELEMETRY_EVENT_INVENTORY,
  recordUpdateOutcomeTelemetry,
  updateOutcomeFromError,
} from "../../src/telemetry/events.ts";

const makeTelemetry = () => {
  const records: Array<{ readonly event: string; readonly data: Readonly<Record<string, unknown>> }> = [];
  const telemetry = {
    enabled: true,
    record: (event: string, data: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        records.push({ event, data });
      }),
  } satisfies typeof Telemetry.Service;
  return { telemetry, records };
};

describe("update telemetry", () => {
  test("inventory freezes update outcome and deprecation-used fields", () => {
    expect(TELEMETRY_EVENT_INVENTORY["update-outcome"]).toEqual([
      "version",
      "targetVersion",
      "channel",
      "platform",
      "outcome",
    ]);
    expect(TELEMETRY_EVENT_INVENTORY["deprecation-used"]).toEqual(["kind", "id", "since", "severity"]);
  });

  test("records success update telemetry with only allowed fields", async () => {
    const { telemetry, records } = makeTelemetry();

    await Effect.runPromise(
      recordUpdateOutcomeTelemetry(telemetry, {
        version: "4.0.0",
        targetVersion: "4.1.0",
        channel: "stable",
        platform: "linux-x64",
        outcome: "success",
      }),
    );

    expect(records).toEqual([
      {
        event: "update-outcome",
        data: {
          version: "4.0.0",
          targetVersion: "4.1.0",
          channel: "stable",
          platform: "linux-x64",
          outcome: "success",
        },
      },
    ]);
    expect(Object.keys(records[0]?.data ?? {})).toEqual(TELEMETRY_EVENT_INVENTORY["update-outcome"]);
  });

  test("maps update failure categories without leaking raw error details", async () => {
    const failures = [
      ["UpdateSignatureVerificationError", "signature_failure"],
      ["UpdateLaunchProbeError", "launch_probe_failure"],
      ["UpdatePermissionError", "permission_failure"],
      ["UpdateNetworkError", "network_failure"],
    ] as const;

    for (const [tag, outcome] of failures) {
      const { telemetry, records } = makeTelemetry();
      const error = { _tag: tag, message: "raw /home/alice/.lando https://example.invalid user@example" };
      await Effect.runPromise(
        recordUpdateOutcomeTelemetry(telemetry, {
          version: "4.0.0",
          targetVersion: "4.1.0",
          channel: "next",
          platform: "darwin-arm64",
          outcome: updateOutcomeFromError(error),
        }),
      );

      expect(outcome).toBe(updateOutcomeFromError(error));
      expect(records[0]?.data).toEqual({
        version: "4.0.0",
        targetVersion: "4.1.0",
        channel: "next",
        platform: "darwin-arm64",
        outcome,
      });
      expect(JSON.stringify(records[0]?.data)).not.toContain("alice");
      expect(JSON.stringify(records[0]?.data)).not.toContain("example.invalid");
      expect(JSON.stringify(records[0]?.data)).not.toContain("/home");
    }
  });

  test("does not record update telemetry when telemetry is disabled", async () => {
    const records: Array<{ readonly event: string; readonly data: Readonly<Record<string, unknown>> }> = [];
    const telemetry = {
      enabled: false,
      record: (event: string, data: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => records.push({ event, data })),
    } satisfies typeof Telemetry.Service;

    await Effect.runPromise(
      recordUpdateOutcomeTelemetry(telemetry, {
        version: "4.0.0",
        targetVersion: "4.1.0",
        channel: "stable",
        platform: "linux-x64",
        outcome: "success",
      }),
    );

    expect(records).toEqual([]);
  });

  test("update command records a success outcome through Telemetry", async () => {
    const { telemetry, records } = makeTelemetry();

    const result = await Effect.runPromise(
      update({ channel: "dev", targetVersion: "4.1.0" }).pipe(Effect.provideService(Telemetry, telemetry)),
    );

    expect(result).toEqual({ updatedCore: false, updatedPlugins: [] });
    expect(records).toEqual([
      {
        event: "update-outcome",
        data: {
          version: "0.0.0",
          targetVersion: "4.1.0",
          channel: "dev",
          platform: `${process.platform}-${process.arch}`,
          outcome: "success",
        },
      },
    ]);
  });

  test("update command records categorized failure outcome before rethrow", async () => {
    const { telemetry, records } = makeTelemetry();
    const failure = new LandoCommandError({
      message: "network failed at https://example.invalid/home/alice",
      commandId: "meta:update",
      cause: { _tag: "UpdateNetworkError", url: "https://example.invalid/home/alice" },
    });

    const exit = await Effect.runPromiseExit(
      update({
        channel: "stable",
        targetVersion: "4.1.0",
        runUpdate: () => Effect.fail(failure),
      }).pipe(Effect.provideService(Telemetry, telemetry)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        Cause.failureOption(exit.cause).pipe((option) => (option._tag === "Some" ? option.value : undefined)),
      ).toBe(failure);
    }

    expect(records).toEqual([
      {
        event: "update-outcome",
        data: {
          version: "0.0.0",
          targetVersion: "4.1.0",
          channel: "stable",
          platform: `${process.platform}-${process.arch}`,
          outcome: "network_failure",
        },
      },
    ]);
  });
});
