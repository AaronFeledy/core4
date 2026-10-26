import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { EngineApiClient, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { volumeCreationLabels } from "../src/volume-creation.ts";
import { storageLifecycleFixture } from "./support/storage-lifecycle-fixture.ts";
import { runStorageLifecycle, storageLifecycleClient } from "./support/storage-lifecycle.ts";

const recordingApi = (respond: (input: EngineHttpRequest) => EngineHttpResponse) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineApiClient = {
    info: Effect.succeed({}),
    request: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return respond(input);
      }),
  };
  return { api, calls };
};

test("cleans captured IDs with anonymous-aware removal when a scenario assertion fails", async () => {
  // Given partial acquisitions and an unrelated runtime resource that was never acquired.
  const fake = recordingApi((input) => {
    if (input.method === "DELETE") return { status: 204, body: "" };
    if (input.path === "/networks/create") return { status: 201, body: '{"Id":"network-id"}' };
    if (input.path === "/volumes/create") return { status: 201, body: JSON.stringify(input.body) };
    if (input.path.startsWith("/containers/create?")) return { status: 201, body: '{"Id":"container/id"}' };
    return {
      status: 200,
      body: JSON.stringify({
        Id: "container/id",
        Mounts: [
          { Type: "volume", Name: "anonymous/id", Destination: "/ephemeral" },
          { Type: "volume", Name: "named-id", Destination: "/retained" },
        ],
      }),
    };
  });
  const failure = new Error("scenario assertion failed");
  // When the scenario exits exceptionally after creating resources.
  const scenario = async () => {
    await using fixture = storageLifecycleFixture(fake.api, "docker");
    await fixture.call({ method: "POST", path: "/networks/create" });
    await fixture.call({
      method: "POST",
      path: "/volumes/create",
      body: {
        Name: "named-id",
        Labels: volumeCreationLabels(fixture.plan, { name: "named-id", scope: "app", kind: "data" }),
      },
    });
    await fixture.call({
      method: "POST",
      path: "/containers/create?name=owned",
      body: { Image: fixture.image },
    });
    throw failure;
  };
  await expect(scenario()).rejects.toBe(failure);
  // Then exact IDs are cleaned in dependency order, not by listing or global pruning.
  const deletes = fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  expect(deletes.slice(0, 4)).toEqual([
    "/containers/container%2Fid?force=true&v=true",
    "/volumes/named-id",
    "/volumes/anonymous%2Fid",
    "/networks/network-id",
  ]);
  expect(deletes).toHaveLength(5);
  expect(deletes[4]).toMatch(/^\/images\/localhost%2Fstorage-[\da-f-]+%3Afixture$/u);
});

test.each([false, true])(
  "preserves an unrelated mounted volume after assertion failure (create=%s)",
  async (create) => {
    // Given a preexisting volume whose generation cannot prove acquisition by this run.
    const fake = recordingApi((input) => {
      if (input.method === "DELETE") return { status: 204, body: "" };
      if (input.path === "/volumes/create") {
        return { status: 201, body: JSON.stringify({ Name: "unrelated", Labels: {} }) };
      }
      if (input.path.startsWith("/containers/create?")) return { status: 201, body: '{"Id":"owned-id"}' };
      return {
        status: 200,
        body: JSON.stringify({
          Id: "owned-id",
          Mounts: [{ Type: "volume", Name: "unrelated", Destination: "/retained" }],
        }),
      };
    });
    const failure = new Error("scenario assertion failed");
    // When the fixture mounts that volume and the scenario fails.
    const scenario = async () => {
      await using fixture = storageLifecycleFixture(fake.api, "docker");
      if (create) {
        await fixture.call({
          method: "POST",
          path: "/volumes/create",
          body: {
            Name: "unrelated",
            Labels: volumeCreationLabels(fixture.plan, { name: "unrelated", scope: "app", kind: "data" }),
          },
        });
      }
      await fixture.call({
        method: "POST",
        path: "/containers/create?name=owned",
        body: { Image: fixture.image, HostConfig: { Binds: ["unrelated:/retained"] } },
      });
      throw failure;
    };
    await expect(scenario()).rejects.toBe(failure);
    // Then container cleanup does not authorize explicit deletion of the borrowed named volume.
    expect(
      fake.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/volumes/")),
    ).toEqual([]);
  },
);

test("attempts remaining cleanup and rejects success when an exact removal fails", async () => {
  // Given a container acquired before its inspect fails, then a failing container delete.
  const fake = recordingApi((input) => {
    if (input.path.startsWith("/containers/create?")) return { status: 201, body: '{"Id":"partial-id"}' };
    if (input.path.startsWith("/containers/")) return { status: 500, body: "injected failure" };
    return { status: 404, body: "" };
  });
  const fixture = storageLifecycleFixture(fake.api, "podman");
  await expect(
    fixture.call({
      method: "POST",
      path: "/containers/create?name=partial",
      body: { Image: fixture.image },
    }),
  ).rejects.toThrow();
  // When disposal encounters failed cleanup.
  await expect(fixture[Symbol.asyncDispose]()).rejects.toBeInstanceOf(AggregateError);
  // Then the later image cleanup still runs and no failed acquisition is lost.
  expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([
    { method: "DELETE", path: "/containers/partial-id?force=true&v=true" },
    { method: "DELETE", path: `/images/${encodeURIComponent(fixture.image)}` },
  ]);
});

test.each([false, true])(
  "borrows an ephemeral volume only when already captured (captured=%s)",
  async (captured) => {
    // Given a volume that may have been captured from this fixture's image.
    const fake = recordingApi((input) => {
      if (input.method === "DELETE") return { status: 204, body: "" };
      if (input.path.startsWith("/containers/create?")) {
        return { status: 201, body: JSON.stringify({ Id: input.path }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          Id: "owner",
          Mounts: [{ Type: "volume", Name: "anonymous/id", Destination: "/ephemeral" }],
        }),
      };
    });
    await using fixture = storageLifecycleFixture(fake.api, "docker");
    if (captured) {
      await fixture.call({
        method: "POST",
        path: "/containers/create?name=owner",
        body: { Image: fixture.image },
      });
    }
    // When a borrower requests that exact volume, then only an already captured ID is accepted.
    const borrow = fixture.call({
      method: "POST",
      path: `/containers/create?name=${fixture.borrower}`,
      body: { Image: fixture.image, HostConfig: { Binds: ["anonymous/id:/ephemeral"] } },
    });
    if (captured) await expect(borrow).resolves.toMatchObject({ status: 201 });
    else {
      await expect(borrow).rejects.toThrow("Borrowed volume must already be captured by this run");
      expect(fake.calls).toEqual([]);
    }
  },
);

test("isolates every planned resource when two fixture runs share a daemon", async () => {
  // Given two independent runs against the same fake daemon.
  const fake = recordingApi(() => ({ status: 404, body: "" }));
  // When each allocates its fixture identity.
  await using first = storageLifecycleFixture(fake.api, "docker");
  await using second = storageLifecycleFixture(fake.api, "docker");
  // Then app roots and every named runtime resource differ, with no published ports or shared network.
  expect(first.plan.root).not.toBe(second.plan.root);
  for (const key of ["image", "retained", "foreign", "borrower", "network"] as const) {
    expect(first[key]).not.toBe(second[key]);
  }
  expect(first.plan.networking?.sharedNetworkMembership).toBeUndefined();
  expect(Object.values(first.plan.services).flatMap((service) => service.endpoints)).toEqual([]);
});

test("does not touch resources when the explicitly selected API cannot answer", async () => {
  // Given a configured but unreachable engine.
  const fake = recordingApi(() => ({ status: 500, body: "must not request" }));
  const api = {
    ...fake.api,
    info: Effect.fail(
      new ProviderUnavailableError({
        providerId: "docker",
        operation: "info",
        message: "unreachable",
      }),
    ),
  };
  // When the driver probes the explicit socket.
  await expect(runStorageLifecycle({ provider: "docker", socket: "/explicit.sock" }, api)).rejects.toThrow();
  // Then neither acquisition nor cleanup runs against that daemon.
  expect(fake.calls).toEqual([]);
});

test("cleans the unique image tag when fixture build fails", async () => {
  // Given a build that fails after receiving its tar context.
  const fake = recordingApi((input) => ({
    status: input.method === "DELETE" ? 404 : 500,
    body: "build failed",
  }));
  // When the ordinary driver fails before container acquisition.
  await expect(
    runStorageLifecycle({ provider: "docker", socket: "/explicit.sock" }, fake.api),
  ).rejects.toThrow();
  // Then cleanup addresses only that build's unique tag, and build failure is not a structured pass.
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]?.path).toMatch(/^\/build\?t=localhost%2Fstorage-/u);
  expect(fake.calls[1]).toMatchObject({ method: "DELETE" });
  expect(fake.calls[1]?.path).toMatch(/^\/images\/localhost%2Fstorage-/u);
});

test("rejects an empty explicit socket instead of discovering a runtime", () => {
  // Given no explicit socket, when a client is requested, then reject before connecting.
  expect(() => storageLifecycleClient({ provider: "podman", socket: "" })).toThrow();
});
