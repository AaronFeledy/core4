import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { Telemetry } from "@lando/sdk/services";

import {
  type TelemetryRecord,
  type TelemetrySink,
  TelemetrySinks,
  makeTelemetryLayer,
} from "../../src/telemetry/service.ts";

const capturingSink = (id = "capture") => {
  const records: Array<TelemetryRecord> = [];
  const sink: TelemetrySink = {
    id,
    record: (event, data) =>
      Effect.sync(() => {
        records.push({ event, data });
      }),
  };
  return { sink, records };
};

const withSinks = (enabled: boolean, sinks: ReadonlyArray<TelemetrySink>, flushBudgetMillis?: number) =>
  makeTelemetryLayer(enabled, flushBudgetMillis === undefined ? undefined : { flushBudgetMillis }).pipe(
    Layer.provide(Layer.succeed(TelemetrySinks, sinks)),
  );

describe("Telemetry transport service", () => {
  test("disabled telemetry reports enabled=false, no-ops record, and never calls sinks", async () => {
    const { sink, records } = capturingSink();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        expect(telemetry.enabled).toBe(false);
        yield* telemetry.record("update-outcome", { outcome: "success" });
        yield* Effect.sleep("20 millis");
      }).pipe(Effect.provide(withSinks(false, [sink])), Effect.scoped),
    );
    expect(records).toEqual([]);
  });

  test("enabled telemetry enqueues records and drains them to sinks in order", async () => {
    const { sink, records } = capturingSink();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        expect(telemetry.enabled).toBe(true);
        yield* telemetry.record("update-outcome", { outcome: "success" });
        yield* telemetry.record("deprecation-used", { id: "x" });
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(withSinks(true, [sink])), Effect.scoped),
    );
    expect(records).toEqual([
      { event: "update-outcome", data: { outcome: "success" } },
      { event: "deprecation-used", data: { id: "x" } },
    ]);
  });

  test("enabled telemetry with no registered sinks records without error", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        expect(telemetry.enabled).toBe(true);
        yield* telemetry.record("update-outcome", { outcome: "success" });
        yield* Effect.sleep("20 millis");
      }).pipe(Effect.provide(makeTelemetryLayer(true)), Effect.scoped),
    );
  });

  test("a failing sink never propagates to the recording fiber and other sinks still run", async () => {
    const failing: TelemetrySink = { id: "fail", record: () => Effect.fail(new Error("boom")) };
    const { sink: good, records } = capturingSink("good");
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* telemetry.record("update-outcome", { outcome: "network_failure" });
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(withSinks(true, [failing, good])), Effect.scoped),
    );
    expect(records).toEqual([{ event: "update-outcome", data: { outcome: "network_failure" } }]);
  });

  test("a hanging sink never blocks record or delays shutdown beyond the flush budget", async () => {
    const hanging: TelemetrySink = { id: "hang", record: () => Effect.never };
    const start = Date.now();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* telemetry.record("update-outcome", { outcome: "success" });
      }).pipe(Effect.provide(withSinks(true, [hanging], 50)), Effect.scoped),
    );
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("empty event names are dropped without enqueue", async () => {
    const { sink, records } = capturingSink();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* telemetry.record("", { outcome: "success" });
        yield* telemetry.record("update-outcome", { outcome: "success" });
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(withSinks(true, [sink])), Effect.scoped),
    );
    expect(records).toEqual([{ event: "update-outcome", data: { outcome: "success" } }]);
  });

  test("records are redacted before they reach any sink", async () => {
    const { sink, records } = capturingSink();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        // Disallowed fields (install dir, raw error) and out-of-set enum values
        // must never reach a sink; allowed enum/string fields survive.
        yield* telemetry.record("update-outcome", {
          version: "4.0.0",
          targetVersion: "4.1.0",
          channel: "stable",
          platform: "linux-x64",
          outcome: "success",
          installDir: "/home/alice/.lando/bin",
          rawError: "failed at /home/alice/project",
        });
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(withSinks(true, [sink])), Effect.scoped),
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
    expect(JSON.stringify(records)).not.toContain("/home/alice");
  });

  test("disabled telemetry never calls sinks even when sinks are registered", async () => {
    const { sink, records } = capturingSink();
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* telemetry.record("update-outcome", { outcome: "success" });
        yield* Effect.sleep("20 millis");
      }).pipe(Effect.provide(withSinks(false, [sink])), Effect.scoped),
    );
    expect(records).toEqual([]);
  });
});
