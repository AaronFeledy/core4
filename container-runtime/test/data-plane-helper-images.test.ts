import { describe, expect, test } from "bun:test";
import { dataHelperImage, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { dockerPullDialect } from "@lando/container-runtime/dialect";
import { pullImage } from "@lando/container-runtime/image-pull";
import { AppId } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Stream } from "effect";
import { FakeEngine } from "./support/fake-engine.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const ctx = { providerId: "test", remediation: "Run `lando doctor` and retry.", env: {} } as const;

const fakeEngine = (input: {
  readonly cached: string | undefined;
  readonly pulled?: string;
  readonly inspectStatus?: number;
}) => {
  const engine = new FakeEngine();
  const inspected = (digest: string) => ({
    Id: "sha256:image",
    Size: 1,
    RepoDigests: [`${dataHelperImage.ref.split("@")[0]}@${digest}`],
  });
  if (input.cached === undefined) engine.assets.images.delete(dataHelperImage.ref);
  else engine.assets.images.set(dataHelperImage.ref, inspected(input.cached));
  if (input.pulled !== undefined) engine.assets.registry.set(dataHelperImage.ref, inspected(input.pulled));
  if (input.inspectStatus !== undefined && input.inspectStatus !== 200)
    engine.fail("image.inspect", { status: input.inspectStatus, body: "boom" });
  return {
    api: engine.api,
    pullApi: {
      request: (input: Parameters<typeof engine.request>[0]) => engine.request(input).pipe(Effect.orDie),
      stream: (input: Parameters<typeof engine.stream>[0]) => engine.stream(input).pipe(Stream.orDie),
    },
    requests: engine.requests,
    registryPulls: () => engine.requests.filter((request) => request.operation === "image.pull").length,
    containerCreates: () => engine.containers.history.map((container) => container.config),
  };
};

const planeFor = (engine: ReturnType<typeof fakeEngine>) =>
  makeProviderDataPlane({
    providerId: "test",
    api: engine.api,
    capabilities: { volumeSnapshot: "native" },
    redactor: passthroughRedactor,
    pullHelperImage: (ref) =>
      pullImage(engine.pullApi, ref, { ctx, dialect: dockerPullDialect, policy: "missing" }),
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
    expect(result).toMatchObject({
      failure: {
        _tag: "ProviderInternalError",
        operation: "snapshotVolume",
        details: { expectedDigest: dataHelperImage.digest, actualDigest: wrong },
      },
    });
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
