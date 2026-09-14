import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { UrlScanner } from "@lando/sdk/services";
import { makeTestUrlScanner } from "@lando/sdk/test";

import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("start probes published URLs through UrlScanner with the plan", async () => {
  const scanner = makeTestUrlScanner();
  const harness = makeHarness();
  await Effect.runPromise(
    startApp(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(Effect.provide(Layer.succeed(UrlScanner, scanner)), Effect.provide(harness.layer)),
  );
  const scan = scanner.calls.find((call) => call.op === "scan");
  expect(scan?.op).toBe("scan");
  expect(scan && "appId" in scan ? scan.appId : undefined).toBe(plan.id);
  expect(scan && "options" in scan ? scan.options?.plan : undefined).toBeDefined();
  expect(scan && "options" in scan ? scan.options?.urls : undefined).toEqual([
    { service: web.name, url: "http://localhost:3000/" },
  ]);
});
