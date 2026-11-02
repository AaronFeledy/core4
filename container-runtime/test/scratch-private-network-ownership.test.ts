import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { DateTime } from "effect";
import { Effect, Result } from "effect";
import type { EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import {
  coherentPrivateNetworkOwnership,
  networkLabelsDecision,
  networkOwnershipLabels,
} from "../src/native-ownership.ts";
import { ensurePrivateNetwork } from "../src/podman/bring-up-networks.ts";

const root = AbsolutePath.make("/tmp/scratch-network-proof");
const appId = AppId.make("scratch-network-proof");
const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Scratch",
  slug: "scratch",
  root,
  provider: ProviderId.make("docker"),
  services: {},
  stores: [],
  routes: [],
  fileSync: [],
  extensions: { "@lando/core/scratch": { id: appId } },
  metadata: { source: "test", runtime: 4, resolvedAt: DateTime.makeUnsafe(0) },
};

test("scratch private networks carry complete six-label proof", () => {
  const labels = networkOwnershipLabels(plan);
  expect(labels).toEqual({
    "dev.lando.app": appId,
    "dev.lando.app-root": root,
    "dev.lando.owner": appIdentityKey("owner", root),
    "dev.lando.provider": "docker",
    "dev.lando.scratch": "TRUE",
    "dev.lando.scratch-id": appId,
  });
  expect(coherentPrivateNetworkOwnership(labels, "docker")).toBe(true);
  expect(networkLabelsDecision({}, labels)).toBe("foreign");
  for (const damaged of [
    { ...labels, "dev.lando.scratch-id": "other" },
    { ...labels, "dev.lando.scratch": "FALSE" },
    { ...labels, "dev.lando.scratch-id": undefined },
    { ...labels, extra: "label" },
  ]) {
    const observed = Object.fromEntries(
      Object.entries(damaged).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    expect(coherentPrivateNetworkOwnership(observed, "docker")).toBe(false);
  }
  const ordinary = networkOwnershipLabels({ ...plan, extensions: {} });
  expect(Object.keys(ordinary)).toHaveLength(4);
  expect(networkLabelsDecision(ordinary, labels)).toBe("foreign");
});

const ctx = { providerId: "docker", remediation: "Retry.", env: {} };
const valid = (labels: Readonly<Record<string, string>>) => ({
  Id: "observed/id",
  Name: "scratch-bridge",
  Driver: "bridge",
  Labels: labels,
});

test.each([false, true])(
  "private verifier accepts exact existing ownership (scratch=%s)",
  async (scratch) => {
    const candidate = scratch ? plan : { ...plan, extensions: {} };
    const labels = networkOwnershipLabels(candidate);
    const calls: EngineHttpRequest[] = [];
    await Effect.runPromise(
      ensurePrivateNetwork(
        (request) =>
          Effect.sync(() => {
            calls.push(request);
            return { status: 200, body: JSON.stringify(valid(labels)) };
          }),
        {
          plan: candidate,
          name: "scratch-bridge",
          driver: "bridge",
          create: () => Effect.die("unexpected create"),
        },
        ctx,
      ),
    );
    expect(calls).toEqual([{ method: "GET", path: "/networks/scratch-bridge" }]);
  },
);

test.each([200, 201])("private verifier creates only after 404 (HTTP %s)", async (status) => {
  const calls: EngineHttpRequest[] = [];
  let created: Readonly<Record<string, string>> | undefined;
  await Effect.runPromise(
    ensurePrivateNetwork(
      (request) =>
        Effect.sync(() => {
          calls.push(request);
          return { status: 404, body: "" };
        }),
      {
        plan,
        name: "scratch-bridge",
        driver: "bridge",
        create: (labels) =>
          Effect.sync(() => {
            created = labels;
            return { status, body: "{}" };
          }),
      },
      ctx,
    ),
  );
  expect(calls).toEqual([{ method: "GET", path: "/networks/scratch-bridge" }]);
  expect(created).toEqual(networkOwnershipLabels(plan));
});

test.each([false, true])("409 competitor is re-inspected once (foreign=%s)", async (foreign) => {
  const calls: EngineHttpRequest[] = [];
  const labels = networkOwnershipLabels(plan);
  let getCount = 0;
  const result = await Effect.runPromise(
    ensurePrivateNetwork(
      (request) =>
        Effect.sync((): EngineHttpResponse => {
          calls.push(request);
          return getCount++ === 0
            ? { status: 404, body: "" }
            : {
                status: 200,
                body: JSON.stringify(
                  valid(foreign ? { ...labels, "dev.lando.scratch-id": "other" } : labels),
                ),
              };
        }),
      {
        plan,
        name: "scratch-bridge",
        driver: "bridge",
        create: () => Effect.succeed({ status: 409, body: "" }),
      },
      ctx,
    ).pipe(Effect.result),
  );
  expect(Result.isFailure(result)).toBe(foreign);
  expect(calls).toEqual([
    { method: "GET", path: "/networks/scratch-bridge" },
    { method: "GET", path: "/networks/scratch-bridge" },
  ]);
});

test.each([
  "old-four",
  "missing-id",
  "null-id",
  "numeric-id",
  "wrong-name",
  "wrong-driver",
  "partial-scratch",
  "extra",
  "empty",
  "malformed",
  "401",
  "403",
  "500",
] as const)("private verifier refuses unproven reuse: %s", async (damage) => {
  const labels = networkOwnershipLabels(plan);
  const observed = valid(labels);
  const body =
    damage === "old-four"
      ? { ...observed, Labels: networkOwnershipLabels({ ...plan, extensions: {} }) }
      : damage === "missing-id"
        ? { ...observed, Id: "" }
        : damage === "null-id"
          ? { ...observed, Id: null }
          : damage === "numeric-id"
            ? { ...observed, Id: 123 }
            : damage === "wrong-name"
              ? { ...observed, Name: "other" }
              : damage === "wrong-driver"
                ? { ...observed, Driver: "macvlan" }
                : damage === "partial-scratch"
                  ? { ...observed, Labels: { ...labels, "dev.lando.scratch-id": "other" } }
                  : damage === "extra"
                    ? { ...observed, Labels: { ...labels, extra: "label" } }
                    : damage === "empty"
                      ? { ...observed, Labels: {} }
                      : observed;
  const calls: EngineHttpRequest[] = [];
  const result = await Effect.runPromise(
    ensurePrivateNetwork(
      (request) =>
        Effect.sync(() => {
          calls.push(request);
          return {
            status: ["401", "403", "500"].includes(damage) ? Number(damage) : 200,
            body: damage === "malformed" ? "{" : JSON.stringify(body),
          };
        }),
      { plan, name: "scratch-bridge", driver: "bridge", create: () => Effect.die("unexpected create") },
      ctx,
    ).pipe(Effect.result),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(calls).toEqual([{ method: "GET", path: "/networks/scratch-bridge" }]);
});
