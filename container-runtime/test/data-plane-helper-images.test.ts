import { describe, expect, test } from "bun:test";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Stream } from "effect";

import {
  type DataPlaneHttpRequest,
  dataHelperImage,
  makeProviderDataPlane,
} from "@lando/container-runtime/data-plane";
import { dockerPullDialect } from "@lando/container-runtime/dialect";
import { pullImage } from "@lando/container-runtime/image-pull";
import { AppId } from "@lando/sdk/schema";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const ctx = { providerId: "test", remediation: "Run `lando doctor` and retry.", env: {} } as const;
const encoder = new TextEncoder();

interface FakeEngine {
  readonly api: {
    readonly request: (
      request: DataPlaneHttpRequest,
    ) => Effect.Effect<{ readonly status: number; readonly body: string }>;
    readonly stream: (request: DataPlaneHttpRequest) => Stream.Stream<Uint8Array>;
  };
  readonly requests: DataPlaneHttpRequest[];
  readonly registryPulls: () => number;
  readonly containerCreates: () => ReadonlyArray<{ readonly Image?: string }>;
}

const fakeEngine = (input: {
  readonly cached: string | undefined;
  readonly pulled?: string;
  readonly inspectStatus?: number;
}): FakeEngine => {
  const requests: DataPlaneHttpRequest[] = [];
  let local = input.cached;
  const inspected = (digest: string) => ({
    status: 200,
    body: JSON.stringify({
      Id: "sha256:image",
      Size: 1,
      RepoDigests: [`${dataHelperImage.ref.split("@")[0]}@${digest}`],
    }),
  });
  const api: FakeEngine["api"] = {
    request: (request) => {
      requests.push(request);
      if (request.path.startsWith("/images/create")) return Effect.succeed({ status: 200, body: "" });
      if (request.path.startsWith("/containers/create")) return Effect.succeed({ status: 201, body: "{}" });
      if (request.path.includes("/wait")) return Effect.succeed({ status: 200, body: '{"StatusCode":0}' });
      if (request.path.startsWith("/commit")) return Effect.succeed({ status: 201, body: "{}" });
      if (request.path.startsWith("/images/localhost")) {
        return Effect.succeed({ status: 200, body: JSON.stringify({ Id: "sha256:snap", Size: 4096 }) });
      }
      if (request.path.startsWith("/images/")) {
        if (input.inspectStatus !== undefined && input.inspectStatus !== 200) {
          return Effect.succeed({ status: input.inspectStatus, body: "boom" });
        }
        return Effect.succeed(local === undefined ? { status: 404, body: "{}" } : inspected(local));
      }
      return Effect.succeed({ status: request.method === "DELETE" ? 204 : 200, body: "{}" });
    },
    stream: (request) => {
      requests.push(request);
      if (request.path.startsWith("/images/create")) {
        local = input.pulled;
        return Stream.make(encoder.encode('{"status":"Pull complete"}\n'));
      }
      return Stream.empty;
    },
  };
  return {
    api,
    requests,
    registryPulls: () => requests.filter((request) => request.path.startsWith("/images/create")).length,
    containerCreates: () =>
      requests
        .filter((request) => request.path.startsWith("/containers/create"))
        .map((request) => (request.body ?? {}) as { readonly Image?: string }),
  };
};

const planeFor = (engine: FakeEngine) =>
  makeProviderDataPlane({
    providerId: "test",
    api: engine.api,
    capabilities: { volumeSnapshot: "native" },
    redactor: passthroughRedactor,
    pullHelperImage: (ref) =>
      pullImage(engine.api, ref, { ctx, dialect: dockerPullDialect, policy: "missing" }),
  });

const snapshot = (plane: ReturnType<typeof planeFor>) =>
  Effect.runPromise(
    Effect.scoped(
      plane.snapshotVolume({ volume: { app: AppId.make("app"), store: "data" }, snapshotId: "snap" }),
    ).pipe(Effect.result),
  );

describe("data-plane helper image acquisition", () => {
  test("runs the native snapshot commit helper from the pinned data helper digest ref", async () => {
    // Given: the pinned helper is already in the local image store.
    const engine = fakeEngine({ cached: dataHelperImage.digest });

    // When: a native snapshot runs.
    const result = await snapshot(planeFor(engine));

    // Then: the helper container is created from the digest ref and no registry pull happens.
    expect(result._tag).toBe("Success");
    expect(engine.containerCreates().map((create) => create.Image)).toEqual([dataHelperImage.ref]);
    expect(engine.registryPulls()).toBe(0);
  });

  test("pulls a missing helper once, verifies the digest, then creates the container", async () => {
    // Given: the helper is absent and the registry serves the pinned content.
    const engine = fakeEngine({ cached: undefined, pulled: dataHelperImage.digest });

    // When: a native snapshot runs.
    const result = await snapshot(planeFor(engine));

    // Then: exactly one registry pull precedes the container create.
    expect(result._tag).toBe("Success");
    expect(engine.registryPulls()).toBe(1);
    const firstPull = engine.requests.findIndex((request) => request.path.startsWith("/images/create"));
    const firstCreate = engine.requests.findIndex((request) => request.path.startsWith("/containers/create"));
    expect(firstPull).toBeGreaterThanOrEqual(0);
    expect(firstPull).toBeLessThan(firstCreate);
  });

  test("fails without creating a container when the acquired digest is not the pin", async () => {
    // Given: the engine holds different content under the helper reference.
    const wrong = `sha256:${"0".repeat(64)}`;
    expect(dataHelperImage.digest).not.toBe(wrong);
    const engine = fakeEngine({ cached: wrong });

    // When: a native snapshot runs.
    const result = await snapshot(planeFor(engine));

    // Then: it fails with the digest mismatch and never creates the helper.
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("digest did not match the pin");
    expect(engine.containerCreates()).toEqual([]);
  });

  test("fails closed on a non-404 inspect failure without pulling or creating", async () => {
    // Given: the engine errors while inspecting the helper image.
    const engine = fakeEngine({ cached: dataHelperImage.digest, inspectStatus: 500 });

    // When: a native snapshot runs.
    const result = await snapshot(planeFor(engine));

    // Then: there is no mutable-tag fallback, pull, or container.
    expect(result._tag).toBe("Failure");
    expect(engine.registryPulls()).toBe(0);
    expect(engine.containerCreates()).toEqual([]);
  });

  test("refuses to run a helper when the provider supplies no acquisition hook", async () => {
    // Given: a data plane built without pullHelperImage.
    const engine = fakeEngine({ cached: dataHelperImage.digest });
    const plane = makeProviderDataPlane({
      providerId: "test",
      api: engine.api,
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
    });

    // When: a native snapshot runs.
    const result = await snapshot(plane);

    // Then: the unverified helper is never created.
    expect(result._tag).toBe("Failure");
    expect(engine.containerCreates()).toEqual([]);
  });
});
