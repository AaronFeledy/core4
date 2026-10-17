import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { UrlScanner } from "@lando/sdk/services";
import { makeTestUrlScanner } from "@lando/sdk/test";

import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("start probes published URLs through UrlScanner with the plan", async () => {
  const scanner = makeTestUrlScanner();
  const harness = makeHarness();
  const result = await Effect.runPromise(
    startApp(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(
      Effect.provide(
        Layer.succeed(UrlScanner, {
          ...scanner,
          scan: (appId, options) =>
            scanner.scan(appId, options).pipe(
              Effect.map((result) => ({
                ...result,
                endpoints: (options?.urls ?? []).map((target) => ({
                  ...target,
                  reachable: true,
                  verdict: "ready" as const,
                  outcome: "green" as const,
                  statusCode: 200,
                })),
              })),
            ),
        }),
      ),
      Effect.provide(harness.layer),
    ),
  );
  const scan = scanner.calls.find((call) => call.op === "scan");
  expect(scan?.op).toBe("scan");
  expect(scan && "appId" in scan ? scan.appId : undefined).toBe(plan.id);
  expect(scan && "options" in scan ? scan.options?.plan : undefined).toBeDefined();
  expect(scan && "options" in scan ? scan.options?.urls : undefined).toEqual([
    { service: web.name, url: "http://localhost:3000/" },
  ]);
  const scanTreeId = `start-scan-${plan.id}`;
  const trees = byTag(harness.events, "task.tree.start");
  expect(trees.map((tree) => tree.parentId).indexOf(scanTreeId)).toBeGreaterThan(
    trees.map((tree) => tree.parentId).indexOf(`apply-${plan.id}`),
  );
  expect(trees.find((tree) => tree.parentId === scanTreeId)).toMatchObject({
    label: `Checking ${plan.name}`,
    children: [`${scanTreeId}:web-1`],
  });
  expect(
    byTag(harness.events, "task.tree.complete").find((tree) => tree.parentId === scanTreeId),
  ).toMatchObject({ summary: `${plan.name} answered on 1 URL`, succeeded: 1, failed: 0 });
  expect(result.checks).toMatchObject([
    {
      id: "http:web:http://localhost:3000/",
      kind: "http",
      service: "web",
      verdict: "ready",
      statusCode: 200,
    },
  ]);
});
