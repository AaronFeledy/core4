import { expect, test } from "bun:test";
import { type AppPlan, landoNetworkingPlan, planAppIdentity } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { removeOrphanedNetworks } from "../src/orphaned-networks.ts";
import { type OwnedResource, makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { networkPlan } from "./authored-network-fixture.ts";

const previous = networkPlan;
const current: AppPlan = {
  ...previous,
  networking: landoNetworkingPlan({
    slug: previous.slug,
    serviceNames: ["web", "worker"],
    sharedCrossAppNetwork: true,
  }),
};
const fixture = (
  options: {
    readonly status?: number;
    readonly inspectStatus?: number;
    readonly body?: string;
    readonly observed?: object;
    readonly scratch?: boolean;
  } = {},
) => {
  const calls: EngineHttpRequest[] = [];
  const retired: OwnedResource[] = [];
  const owner = planAppIdentity(previous);
  const source = options.scratch
    ? { ...previous, extensions: { "@lando/core/scratch": { id: previous.id } } }
    : previous;
  const resource: OwnedResource = {
    ...owner,
    appId: previous.id,
    providerId: previous.provider,
    kind: "network",
    role: "authored",
    nativeName: "lando-networks_private",
    ...(options.scratch ? { scratchId: previous.id } : {}),
    identityDigest: "test",
  };
  return {
    calls,
    retired,
    resource,
    options: {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      api: {
        request: (request: EngineHttpRequest) =>
          Effect.sync(() => {
            calls.push(request);
            return request.method === "GET"
              ? {
                  status: options.inspectStatus ?? 200,
                  body: JSON.stringify(
                    options.observed ?? {
                      Id: "verified/id",
                      Name: resource.nativeName,
                      Labels: networkOwnershipLabels(source),
                    },
                  ),
                }
              : { status: options.status ?? 204, body: options.body ?? "" };
          }),
      },
      store: {
        ...makeResourceOwnershipStore("docker"),
        load: () =>
          Effect.succeed({
            ...owner,
            providerId: previous.provider,
            appIds: [previous.id],
            resources: [resource],
          }),
        retire: (_root: AppPlan["root"], value: OwnedResource) =>
          Effect.sync(() => {
            retired.push(value);
          }),
      },
    },
  };
};

test.each([false, true])(
  "orphan scratch authored network requires full proof (old-four=%s)",
  async (oldFour) => {
    const scratchPrevious = { ...previous, extensions: { "@lando/core/scratch": { id: previous.id } } };
    const scratchCurrent = { ...current, extensions: scratchPrevious.extensions };
    const fake = fixture({
      scratch: true,
      ...(oldFour
        ? {
            observed: {
              Id: "verified/id",
              Name: "lando-networks_private",
              Labels: networkOwnershipLabels(previous),
            },
          }
        : {}),
    });
    const result = await Effect.runPromise(
      removeOrphanedNetworks(scratchCurrent, scratchPrevious, fake.options).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(oldFour);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      oldFour
        ? ["GET /networks/lando-networks_private"]
        : ["GET /networks/lando-networks_private", "DELETE /networks/verified%2Fid"],
    );
    expect(fake.retired).toEqual(oldFour ? [] : [fake.resource]);
  },
);

test.each([204, 404])(
  "removes only the orphan authored network by verified id and retires it (HTTP %s)",
  async (status) => {
    // Given
    const fake = fixture({ status });
    // When
    await Effect.runPromise(removeOrphanedNetworks(current, previous, fake.options));
    // Then
    expect(fake.calls).toEqual([
      { method: "GET", path: "/networks/lando-networks_private" },
      { method: "DELETE", path: "/networks/verified%2Fid" },
    ]);
    expect(fake.retired).toEqual([fake.resource]);
  },
);

test.each([403, 409, 500])(
  "skips networks with active endpoints without retiring them (HTTP %s)",
  async (status) => {
    // Given
    const fake = fixture({
      status,
      body:
        status === 500
          ? "network is being used"
          : status === 403
            ? "network has active endpoints"
            : "network is in use",
    });
    // When
    await Effect.runPromise(removeOrphanedNetworks(current, previous, fake.options));
    // Then
    expect(fake.calls.at(-1)?.method).toBe("DELETE");
    expect(fake.retired).toEqual([]);
  },
);

test.each([undefined, current])(
  "does nothing without an orphan in the previous plan (%s)",
  async (before) => {
    // Given
    const fake = fixture();
    // When
    await Effect.runPromise(removeOrphanedNetworks(current, before, fake.options));
    // Then
    expect(fake.calls).toEqual([]);
  },
);

test("retains a network when its physical name is still attached under another authored key", async () => {
  // Given
  const fake = fixture();
  const retained: AppPlan = {
    ...current,
    networking: {
      ...previous.networking,
      perAppBridge: previous.networking?.perAppBridge ?? null,
      authoredNetworks: (previous.networking?.authoredNetworks ?? []).map((network) => ({
        ...network,
        key: `${network.key}-renamed`,
      })),
    },
  };
  // When
  await Effect.runPromise(removeOrphanedNetworks(retained, previous, fake.options));
  // Then
  expect(fake.calls).toEqual([]);
});

test("retires an already absent orphan without deleting by name", async () => {
  // Given
  const fake = fixture({ inspectStatus: 404 });
  // When
  await Effect.runPromise(removeOrphanedNetworks(current, previous, fake.options));
  // Then
  expect(fake.calls.map(({ method }) => method)).toEqual(["GET"]);
  expect(fake.retired).toEqual([fake.resource]);
});

test("propagates unrelated removal failures without retiring the orphan", async () => {
  // Given
  const fake = fixture({ status: 500, body: "backend unavailable" });
  // When
  const result = await Effect.runPromise(
    removeOrphanedNetworks(current, previous, fake.options).pipe(Effect.result),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(fake.retired).toEqual([]);
});

test.each([
  { Id: "foreign", Name: "lando-networks_private", Labels: { owner: "someone else" } },
  { Id: "legacy", Name: "lando-networks_private", Labels: {} },
  { Id: "prefix-match", Name: "another-network", Labels: networkOwnershipLabels(previous) },
])("refuses unverified ownership or a non-exact network name (%s)", async (observed) => {
  // Given
  const fake = fixture({ observed });
  // When
  const result = await Effect.runPromise(
    removeOrphanedNetworks(current, previous, fake.options).pipe(Effect.result),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(fake.calls.map(({ method }) => method)).toEqual(["GET"]);
  expect(fake.retired).toEqual([]);
});
