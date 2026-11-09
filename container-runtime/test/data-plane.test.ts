import { describe, expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import {
  ArtifactTransferError,
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceCopyError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { echoHelperPull } from "./helper-pull-support.ts";
import { FakeEngine } from "./support/fake-engine.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

const stdinBytes = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes(value);
  },
});

const _collectAsyncBytes = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  if (input !== undefined) for await (const chunk of input) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const multiplexedFrame = (stream: "stdout" | "stderr", payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = stream === "stdout" ? 1 : 2;
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
};

const _multiplexedStdoutFrame = (payload: Uint8Array): Uint8Array => multiplexedFrame("stdout", payload);
const _multiplexedStderrFrame = (payload: Uint8Array): Uint8Array => multiplexedFrame("stderr", payload);

const appId = AppId.make("app-id");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("test");
const volumeGeneration = "00000000-0000-4000-8000-000000000001";
const adoptedGeneration = "00000000-0000-4000-8000-000000000009";
const replacementGeneration = "00000000-0000-4000-8000-000000000010";
const adoptedOwnerRoot = AbsolutePath.make("/canonical/app");
const removableSnapshot = {
  provider: "test",
  id: "SNAP/name",
  digest: "sha256:snap",
  sizeBytes: 1,
  format: "native" as const,
};

describe("snapshot artifact removal", () => {
  test.each([
    { capability: "none", operation: "snapshotVolume", format: "native" },
    { capability: "none", operation: "restoreVolume", format: "native" },
    { capability: "none", operation: "removeVolumeSnapshot", format: "native" },
    { capability: "native", operation: "restoreVolume", format: "tar" },
    { capability: "native", operation: "removeVolumeSnapshot", format: "tar" },
  ] as const)(
    "rejects $operation with capability $capability and format $format before HTTP",
    async ({ capability, operation, format }) => {
      let requests = 0;
      const engine = new FakeEngine();
      engine.observers.set("image.delete", () => {
        requests += 1;
      });
      const plane = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: capability },
        redactor: passthroughRedactor,
        api: engine.api,
      });
      const snapshot = { ...removableSnapshot, format };
      const action =
        operation === "snapshotVolume"
          ? plane.snapshotVolume({ volume: { app: appId, store: "data" } }).pipe(Effect.asVoid)
          : operation === "restoreVolume"
            ? plane.restoreVolume({
                snapshot,
                target: { app: appId, store: "data" },
                expectedTargetGeneration: volumeGeneration,
              })
            : plane.removeVolumeSnapshot(snapshot);
      const result = await Effect.runPromise(Effect.scoped(action).pipe(Effect.result));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProviderCapabilityError",
          operation,
          capability: "volumeSnapshot",
          requiredValue: "native",
          actualValue: capability === "none" ? "none" : "tar",
          remediation: expect.any(String),
        },
      });
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProviderCapabilityError);
      expect(requests).toBe(0);
    },
  );

  test.each([200, 204, 404])("native removal accepts HTTP %s", async (status) => {
    const requests: string[] = [];
    const engine = new FakeEngine().fail("image.delete", { status, body: "" });
    engine.observers.set("image.delete", (request) => requests.push(`${request.method} ${request.path}`));
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      api: engine.api,
    });
    await Effect.runPromise(Effect.scoped(plane.removeVolumeSnapshot(removableSnapshot)));
    expect(requests).toEqual(["DELETE /images/localhost%2Flando-volume-snapshot%3Asnap-name"]);
  });

  test("native removal fails tagged on an image in use", async () => {
    const engine = new FakeEngine().fail("image.delete", { status: 409, body: "image in use" });
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      api: engine.api,
    });
    const result = await Effect.runPromise(
      Effect.scoped(plane.removeVolumeSnapshot(removableSnapshot)).pipe(Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "VolumeOperationError", operation: "removeVolumeSnapshot" },
    });
  });

  test("foreign provider snapshots fail without HTTP requests", async () => {
    let requests = 0;
    const engine = new FakeEngine();
    engine.observers.set("image.delete", () => {
      requests += 1;
    });
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      api: engine.api,
    });
    const result = await Effect.runPromise(
      Effect.scoped(plane.removeVolumeSnapshot({ ...removableSnapshot, provider: "docker" })).pipe(
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "VolumeOperationError", remediation: "Remove this snapshot with provider docker." },
    });
    expect(requests).toBe(0);
  });
});
const plan = {
  id: appId,
  name: "App Name",
  slug: "app-slug",
  root: AbsolutePath.make("/tmp/app"),
  provider: providerId,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: "2026-06-30T00:00:00Z" as never,
    source: "data-plane test",
    runtime: 4,
  },
  extensions: {},
} satisfies AppPlan;

const makeWitnessVolumeApi = (
  initialGeneration = adoptedGeneration,
  labels: Readonly<Record<string, string>> = {},
) => {
  const engine = new FakeEngine();
  const volume = {
    Name: "data",
    Driver: "local",
    Options: {},
    ...(Object.keys(labels).length === 0 ? {} : { Labels: labels }),
  };
  engine.assets.volumes.set("data", volume);
  engine.assets.images.set("localhost/lando-volume-snapshot:snapshot", { Id: "sha256:snapshot", Size: 8 });
  const setGeneration = (generation: string) => {
    engine.containers.behavior = {
      stdout: bytes(`${JSON.stringify({ version: 1, generation, ownerRoot: adoptedOwnerRoot })}\n`),
    };
  };
  setGeneration(initialGeneration);
  return {
    api: engine.api,
    requests: engine.httpRequests,
    replace: () => {
      engine.assets.volumes.set("data", { ...volume });
      setGeneration(replacementGeneration);
    },
  };
};

describe("provider data plane", () => {
  test("imports artifacts from newline-delimited provider load progress", async () => {
    const engine = new FakeEngine();
    engine.assets.loadRef = "example/app:latest";
    engine.assets.loadFormat = "progress";
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const ref = await Effect.runPromise(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(ref.providerId).toBe(ProviderId.make("test"));
    expect(ref.ref).toBe("example/app:latest");
  });

  test("starts artifact upload before requesting the next producer chunk", async () => {
    // Given: a producer that permits its second chunk only after the provider request starts.
    let requestStarted = false;
    let uploaded = "";
    const sourceError = new ArtifactTransferError({
      providerId: "test",
      operation: "importArtifact",
      message: "Provider request did not start before the producer resumed.",
      remediation:
        "Confirm the image or artifact reference is reachable and credentials are valid, then retry the transfer.",
    });
    const source = Stream.fromAsyncIterable(
      (async function* () {
        yield bytes("first");
        if (!requestStarted) throw sourceError;
        yield bytes("second");
      })(),
      (cause) => (cause instanceof ArtifactTransferError ? cause : sourceError),
    );
    const engine = new FakeEngine();
    engine.assets.loadRef = "sha256:streamed";
    engine.observers.set("image.load", () => {
      requestStarted = true;
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    // When: the artifact is imported through the provider data plane.
    const ref = await Effect.runPromise(provider.importArtifact(source));

    // Then: request consumption and producer emission interleave without buffering the payload first.
    uploaded = text(engine.assets.uploads[0] ?? new Uint8Array());
    expect(uploaded).toBe("firstsecond");
    expect(ref.ref).toBe("sha256:streamed");
  });

  test("streams an artifact larger than two GiB through the provider request", async () => {
    // Given: a reusable one-MiB chunk emitted enough times to cross the signed 32-bit boundary.
    const chunk = new Uint8Array(1024 * 1024);
    const chunkCount = 2049;
    const source = Stream.fromIterable(Array.from({ length: chunkCount })).pipe(Stream.map(() => chunk));
    let uploadedBytes = 0;
    const engine = new FakeEngine();
    engine.assets.retainUploads = false;
    engine.assets.loadRef = "sha256:large";
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    // When: the real artifact-import path forwards the source to the provider API.
    const ref = await Effect.runPromise(provider.importArtifact(source));

    // Then: every byte crosses the production boundary without a whole-payload allocation.
    uploadedBytes = engine.assets.uploadedBytes;
    expect(uploadedBytes).toBe(chunk.byteLength * chunkCount);
    expect(uploadedBytes).toBeGreaterThan(2 * 1024 * 1024 * 1024);
    expect(ref.ref).toBe("sha256:large");
  });

  test("propagates artifact producer failures from the provider request", async () => {
    // Given: an upload producer that fails after its first chunk.
    const sourceError = new ArtifactTransferError({
      providerId: "test",
      operation: "produceArtifact",
      message: "Artifact producer failed.",
      remediation:
        "Confirm the image or artifact reference is reachable and credentials are valid, then retry the transfer.",
    });
    const engine = new FakeEngine();
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const source = Stream.concat(Stream.make(bytes("first")), Stream.fail(sourceError));

    // When: the provider consumes the failing producer.
    const exit = await Effect.runPromiseExit(provider.importArtifact(source));

    // Then: the import fails instead of returning an image reference.
    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure") {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ArtifactTransferError);
    }
  });

  test("imports artifacts from image-load aux ids", async () => {
    const engine = new FakeEngine();
    engine.assets.loadRef = "sha256:abc123";
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const ref = await Effect.runPromise(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(ref.ref).toBe("sha256:abc123");
  });

  test("fails artifact imports when the provider omits an image ref", async () => {
    const engine = new FakeEngine().fail("image.load", {
      status: 200,
      body: JSON.stringify({ stream: "Loading layer 1/1\n" }),
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const exit = await Effect.runPromiseExit(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure") {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ArtifactTransferError);
    }
  });

  test("treats native snapshot wait responses without StatusCode as successful", async () => {
    const paths: string[] = [];
    const deletedImages: string[] = [];
    const commits: unknown[] = [];
    const engine = new FakeEngine().fail("container.wait", { status: 200, body: "{}" });
    engine.observers.set("image.commit", (request) => {
      paths.push(request.path);
      commits.push(request.body);
    });
    engine.observers.set("image.delete", (request) => {
      paths.push(request.path);
      deletedImages.push(request.path);
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
    });

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({
          volume: { app: AppId.make("app"), store: "data" },
          snapshotId: "snap",
          labels: {
            custom: "value",
            "dev.lando.snapshot-store": "store-key",
            "dev.lando.volume-snapshot": "FALSE",
            "dev.lando.volume-owner": "/forged/root",
            "dev.lando.volume-selector": "forged",
          },
        }),
      ),
    );

    expect(snapshot.provider).toBe(ProviderId.make("test"));
    expect(snapshot.id).toBe("snap");
    expect(snapshot).toMatchObject({ digest: "sha256:native-snapshot", sizeBytes: 4096, format: "native" });
    expect(deletedImages).toEqual([]);
    expect(paths.some((path) => path.includes("/commit?"))).toBe(true);
    expect(commits).toEqual([
      {
        Labels: {
          custom: "value",
          "dev.lando.snapshot-store": "store-key",
          "dev.lando.volume-snapshot": "TRUE",
          "dev.lando.snapshot-id": "snap",
          "dev.lando.app": "app",
          "dev.lando.store": "data",
          "dev.lando.provider": "test",
        },
      },
    ]);
  });

  test.each([204, 404, 500, "transport failure"] as const)(
    "rolls back a committed snapshot and preserves the inspect error when deletion returns %s",
    async (deleteResult) => {
      // Given: commit succeeds but the following image inspection fails.
      const requests: string[] = [];
      const inspectError = new VolumeOperationError({
        providerId: "test",
        operation: "inspect",
        message: "Image inspection unavailable.",
        remediation: "Inspect provider volume state and retry the `inspect` volume operation.",
      });
      const deleteError = new VolumeOperationError({
        providerId: "test",
        operation: "delete",
        message: "Image deletion unavailable.",
        remediation: "Inspect provider volume state and retry the `delete` volume operation.",
      });
      const engine = new FakeEngine().fail("image.inspect", inspectError);
      engine.fail(
        "image.delete",
        deleteResult === "transport failure" ? deleteError : { status: deleteResult, body: "" },
      );
      for (const operation of ["image.commit", "image.delete"] as const)
        engine.observers.set(operation, (request) => requests.push(`${request.method} ${request.path}`));
      const provider = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "native" },
        redactor: passthroughRedactor,
        pullHelperImage: echoHelperPull(),
        api: engine.api,
      });

      // When: the snapshot fails before a reference can be returned.
      const result = await Effect.runPromise(
        Effect.scoped(
          provider.snapshotVolume({ volume: { app: appId, store: "data" }, snapshotId: "SNAP/name" }),
        ).pipe(Effect.result),
      );

      // Then: rollback targets the committed tag without replacing the original failure.
      expect(requests.some((request) => request.startsWith("POST /commit?"))).toBe(true);
      expect(requests.filter((request) => request.startsWith("DELETE /images/"))).toEqual([
        "DELETE /images/localhost%2Flando-volume-snapshot%3Asnap-name",
      ]);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "VolumeOperationError",
          operation: inspectError.operation,
          remediation: inspectError.remediation,
        },
      });
    },
  );

  test("rolls back a snapshot when interrupted during the commit request", async () => {
    // Given: the daemon receives the commit but never returns a response.
    const commitStarted = Deferred.makeUnsafe<void>();
    const deletedImages: string[] = [];
    const engine = new FakeEngine().hang("image.commit", commitStarted);
    engine.observers.set("image.delete", (request) => deletedImages.push(request.path));
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
      api: engine.api,
    });

    // When: the snapshot fiber is interrupted only after the commit request starts.
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            provider.snapshotVolume({ volume: { app: appId, store: "data" }, snapshotId: "snap" }),
          );
          yield* Deferred.await(commitStarted);
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ),
    );

    // Then: cancellation stays cancellation, and the unreturned image is removed.
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(deletedImages).toEqual(["/images/localhost%2Flando-volume-snapshot%3Asnap"]);
  });

  test.each([
    { phase: "before commit", snapshotId: "snap" },
    { phase: "inspect without caller id", snapshotId: undefined },
  ])("leaves snapshot images alone on failure $phase", async ({ phase, snapshotId }) => {
    // Given: either commit has not been reached or no caller-supplied id exists.
    const deletedImages: string[] = [];
    const engine = new FakeEngine().fail(phase === "before commit" ? "container.start" : "image.inspect", {
      status: 500,
      body: "{}",
    });
    engine.observers.set("image.delete", (request) => deletedImages.push(request.path));
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
      api: engine.api,
    });

    // When: snapshot creation fails at the selected boundary.
    const result = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({
          volume: { app: appId, store: "data" },
          ...(snapshotId === undefined ? {} : { snapshotId }),
        }),
      ).pipe(Effect.result),
    );

    // Then: failure propagates without deleting an image outside rollback ownership.
    expect(result._tag).toBe("Failure");
    expect(deletedImages).toEqual([]);
  });

  test("forwards ephemeral stdin and lets the transport end it without aborting the attach", async () => {
    const engine = new FakeEngine();
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["cat"],
          stdinStream: stdinBytes("streamed stdin"),
          remove: true,
        }),
      ),
    );

    const attached = text(engine.containers.history[0]?.stdin ?? new Uint8Array());
    expect(attached).toBe("streamed stdin");
    expect(result.exitCode).toBe(0);
  });

  test("does not leave ephemeral stdin open without a forwarded stream", async () => {
    let attachCalled = false;
    const engine = new FakeEngine();
    engine.observers.set("container.attach", () => {
      attachCalled = true;
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["cat"],
          stdin: "inherit",
          remove: true,
        }),
      ),
    );

    const createBody = engine.containers.history[0]?.config;
    expect(createBody).toMatchObject({ OpenStdin: false, AttachStdin: false, StdinOnce: false });
    expect(attachCalled).toBe(false);
  });

  test("creates owned data-store volumes before ephemeral containers", async () => {
    // Given: an app-owned store and a provider API that records creation order and payloads.
    const requests: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> = [];
    const engine = new FakeEngine();
    for (const operation of [
      "volume.create",
      "container.create",
      "container.start",
      "container.wait",
      "container.inspect",
      "container.delete",
    ] as const)
      engine.observers.set(operation, (request) => requests.push(request));
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const ownedPlan = {
      ...plan,
      identity: { appRoot: AbsolutePath.make("/canonical/app"), ownerKey: "canonical-app" },
      stores: [{ name: "data", scope: "app" as const, kind: "data" as const }],
    } satisfies AppPlan;
    const spec = {
      owner: { app: appId, plan: ownedPlan },
      image: "alpine:3.20",
      command: ["true"],
      mounts: [
        { type: "volume" as const, store: "data", target: PortablePath.make("/data"), readOnly: false },
      ],
      remove: true,
    };

    // When: the external ephemeral run mounts the app-owned store.
    await Effect.runPromise(Effect.scoped(provider.run(spec)));

    // Then: the store is explicitly created with provenance before the container can auto-create it.
    const volumeCreateIndex = requests.findIndex((request) => request.path === "/volumes/create");
    const containerCreateIndex = requests.findIndex((request) =>
      request.path.startsWith("/containers/create?name="),
    );
    expect(volumeCreateIndex).toBeGreaterThanOrEqual(0);
    expect(volumeCreateIndex).toBeLessThan(containerCreateIndex);
    expect(requests[volumeCreateIndex]?.body).toMatchObject({
      Name: "data",
      Labels: {
        "dev.lando.app": "app-id",
        "dev.lando.store": "data",
        "dev.lando.scope": "app",
        "dev.lando.volume-instance": expect.any(String),
        "dev.lando.volume-owner": "/canonical/app",
      },
    });
    expect(requests[containerCreateIndex]?.body).toMatchObject({
      Labels: {
        "dev.lando.role": "data-helper",
        "dev.lando.provider": "test",
        "dev.lando.app": "app-id",
        "dev.lando.app-root": "/canonical/app",
        "dev.lando.store": "data",
      },
      HostConfig: { Binds: ["data:/data"] },
    });
    expect(requests.filter(({ method }) => method === "DELETE")).toEqual([
      { method: "DELETE", path: expect.stringMatching(/^\/containers\/[^/?]+\?force=true&v=true$/u) },
    ]);
  });

  for (const streaming of [false, true]) {
    for (const outcome of ["success", "failure", "interruption"] as const) {
      test.each([false, true])(
        `ephemeral cleanup after ${outcome} (streaming=${streaming}, remove=%s)`,
        async (remove) => {
          const requests: Array<{ readonly method: string; readonly path: string }> = [];
          const entered = Deferred.makeUnsafe<void>();
          const engine = new FakeEngine();
          for (const operation of [
            "container.create",
            "container.start",
            "container.wait",
            "container.inspect",
            "container.delete",
          ] as const)
            engine.observers.set(operation, (request) => requests.push(request));
          if (outcome === "interruption") engine.hang("container.start", entered);
          if (outcome === "failure") engine.fail("container.start", { status: 500, body: "start failed" });
          const provider = makeProviderDataPlane({
            providerId: "test",
            capabilities: { volumeSnapshot: "none" },
            redactor: passthroughRedactor,
            api: engine.api,
          });
          const spec = { image: "alpine:3.20", command: ["true"], remove };
          const run = Effect.scoped(
            streaming ? provider.runStream(spec).pipe(Stream.runDrain) : provider.run(spec),
          );
          const exit = await Effect.runPromise(
            outcome === "interruption"
              ? Effect.gen(function* () {
                  const fiber = yield* Effect.forkChild(run);
                  yield* Deferred.await(entered);
                  yield* Fiber.interrupt(fiber);
                  return yield* Fiber.await(fiber);
                })
              : Effect.exit(run),
          );
          expect(Exit.isSuccess(exit)).toBe(outcome === "success");
          expect(requests.filter(({ method }) => method === "DELETE")).toEqual(
            remove
              ? [
                  {
                    method: "DELETE",
                    path: expect.stringMatching(/^\/containers\/[^/?]+\?force=true&v=true$/u),
                  },
                ]
              : [],
          );
        },
      );
    }
  }

  test("preserves colon targets in ephemeral API Mounts", async () => {
    // Given
    let createBody: unknown;
    const engine = new FakeEngine();
    engine.observers.set("container.create", (request) => {
      createBody = request.body;
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const ownedPlan: AppPlan = {
      ...plan,
      identity: { appRoot: AbsolutePath.make("/canonical/app"), ownerKey: "canonical-app" },
      stores: [{ name: "data", scope: "app", kind: "data" }],
    };
    // When
    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          owner: { app: appId, plan: ownedPlan },
          image: "alpine:3.20",
          command: ["true"],
          mounts: [
            { type: "volume", store: "data", target: PortablePath.make("/data:ro"), readOnly: true },
            { type: "volume", store: "data", target: PortablePath.make("/ordinary"), readOnly: false },
          ],
          remove: true,
        }),
      ),
    );
    // Then
    expect(createBody).toMatchObject({
      HostConfig: {
        Binds: ["data:/ordinary"],
        Mounts: [{ Type: "volume", Source: "data", Target: "/data:ro", ReadOnly: true }],
      },
    });
  });

  test("forwards ephemeral bind mounts, user, and empty entrypoint", async () => {
    let createBody: unknown;
    const api: DataPlaneApiClient = {
      request: (request) => {
        if (request.path.startsWith("/containers/create?name=")) createBody = request.body;
        return Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        );
      },
      stream: () => Stream.empty,
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "docker.io/keinos/sqlite3:3.54.1",
          command: ["sqlite3", "/app/db.sqlite", ".dump"],
          binds: [{ source: "/host/app", target: "/app" }],
          user: "33:33",
          entrypoint: [],
          remove: true,
        }),
      ),
    );

    expect(createBody).toMatchObject({
      User: "33:33",
      Entrypoint: [],
      HostConfig: {
        Mounts: [{ Type: "bind", Source: "/host/app", Target: "/app", ReadOnly: false }],
      },
    });
  });

  test("adopts an existing ephemeral volume without treating submitted labels as observed", async () => {
    // Given: the daemon reports that the declared volume already exists.
    const requests: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const engine = new FakeEngine();
    engine.assets.volumes.set("data", { Name: "data" });
    engine.onRequest = (request) => requests.push(request);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const ownedPlan = {
      ...plan,
      identity: { appRoot: adoptedOwnerRoot, ownerKey: "canonical-app" },
      stores: [{ name: "data", scope: "app" as const, kind: "data" as const }],
    } satisfies AppPlan;

    // When: an ephemeral helper mounts the pre-existing declared store.
    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          owner: { app: appId, plan: ownedPlan },
          image: "alpine:3.20",
          command: ["true"],
          mounts: [{ type: "volume", store: "data", target: PortablePath.make("/data"), readOnly: false }],
          remove: true,
        }),
      ),
    );

    // Then: 409 remains idempotent legacy adoption and container creation still follows it.
    expect(requests.map(({ path }) => path)).toContain("/volumes/create");
    expect(requests.some(({ path }) => path.startsWith("/containers/create?name="))).toBe(true);
    expect(requests.filter(({ path }) => path === "/volumes/create")).toHaveLength(1);
  });

  test("rejects data-store mounts without resolved canonical ownership", async () => {
    // Given: a direct data-plane caller supplies only an app id.
    const requests: string[] = [];
    const engine = new FakeEngine();
    engine.onRequest = (request) => requests.push(request.path);
    const provider = makeProviderDataPlane({
      providerId: "test",
      api: engine.api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    // When: the caller asks to mount a named data store.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.run({
          owner: { app: appId },
          image: "alpine:3.20",
          command: ["true"],
          mounts: [{ type: "volume", store: "data", target: PortablePath.make("/data"), readOnly: false }],
        }),
      ),
    );

    // Then: no daemon mutation is attempted without an applied canonical plan.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(requests).toEqual([]);
  });

  test("decodes Docker multiplexed stdout frames with big-endian lengths", async () => {
    const engine = new FakeEngine({ stdout: bytes("hello from logs") });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["echo", "hello from logs"],
          captureStdout: true,
          remove: true,
        }),
      ),
    );

    expect(result.stdout).toBe("hello from logs");
  });

  test("captures Docker multiplexed stderr frames from ephemeral runs", async () => {
    const paths: string[] = [];
    const engine = new FakeEngine({ exitCode: 1, stderr: bytes("helper failed") });
    engine.onRequest = (request) => paths.push(request.path);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["sh", "-c", "echo helper failed >&2; exit 1"],
          remove: true,
        }),
      ),
    );

    expect(result).toMatchObject({ exitCode: 1, stdout: "", stderr: "helper failed" });
    expect(paths.some((path) => path.includes("/logs?stdout=false&stderr=true"))).toBe(true);
  });

  test("streams Docker multiplexed stderr frames from ephemeral runs", async () => {
    const engine = new FakeEngine({ exitCode: 1, stdout: bytes("stdout"), stderr: bytes("stderr") });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const chunks = await Effect.runPromise(
      Effect.scoped(
        provider
          .runStream({
            image: "alpine:3.20",
            command: ["sh", "-c", "echo stdout; echo stderr >&2"],
            remove: true,
          })
          .pipe(Stream.runCollect),
      ),
    );

    expect(Array.from(chunks)).toEqual([
      { kind: "stdout", chunk: bytes("stdout") },
      { kind: "stderr", chunk: bytes("stderr") },
      { exitCode: 1 },
    ]);
  });

  test("emits provider run output before waiting for process completion", async () => {
    // Given: a provider whose wait request records whether streaming was deferred until completion.
    let waited = false;
    const engine = new FakeEngine({ stdout: bytes("first") });
    engine.observers.set("container.wait", () => {
      waited = true;
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    // When: a consumer asks for only the first streamed chunk.
    const chunks = await Effect.runPromise(
      Effect.scoped(
        provider
          .runStream({ image: "alpine:3.20", command: ["echo", "first"], remove: true })
          .pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // Then: output was observable without buffering through the wait/inspect path.
    expect(Array.from(chunks)).toEqual([{ kind: "stdout", chunk: bytes("first") }]);
    expect(waited).toBe(false);
  });

  test("rejects restore and removal when the observed volume generation changed", async () => {
    const mutations: string[] = [];
    const engine = new FakeEngine();
    engine.assets.images.set("localhost/lando-volume-snapshot:snap", { Id: "sha256:snapshot", Size: 0 });
    engine.assets.volumes.set("data", {
      Name: "data",
      Labels: { "dev.lando.volume-instance": volumeGeneration },
    });
    engine.onRequest = (request) => {
      if (request.method !== "GET") mutations.push(`${request.method} ${request.path}`);
    };
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
    });
    const staleGeneration = "00000000-0000-4000-8000-000000000002";

    const restore = await Effect.runPromiseExit(
      Effect.scoped(
        provider.restoreVolume({
          snapshot: {
            provider: ProviderId.make("test"),
            id: "snap",
            digest: "sha256:snapshot",
            sizeBytes: 0,
            format: "native",
          },
          target: { app: AppId.make("app"), store: "data" },
          expectedTargetGeneration: staleGeneration,
        }),
      ),
    );
    const remove = await Effect.runPromiseExit(
      provider.removeVolume({ app: AppId.make("app"), store: "data" }, staleGeneration),
    );

    expect(Exit.isFailure(restore)).toBe(true);
    expect(Exit.isFailure(remove)).toBe(true);
    expect(mutations).toEqual([]);
  });

  test("filters volume listings to matching Lando labels", async () => {
    const engine = new FakeEngine();
    for (const volume of [
      { Name: "unrelated" },
      {
        Name: "app-data",
        Labels: {
          "dev.lando.app": "app",
          "dev.lando.scope": "app",
          "dev.lando.store": "data",
          "dev.lando.volume-instance": "volume-instance-1",
        },
      },
      {
        Name: "other-data",
        Labels: { "dev.lando.app": "other", "dev.lando.scope": "app", "dev.lando.store": "data" },
      },
    ])
      engine.assets.volumes.set(volume.Name, volume);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes.map((volume) => volume.ref.store)).toEqual(["data"]);
    expect(volumes[0]?.instanceId).toBe("volume-instance-1");
    expect(volumes[0]?.provenance).toBe("known");
  });

  test("reads Podman bare-array volume listings", async () => {
    const engine = new FakeEngine();
    engine.assets.volumeListFormat = "podman";
    for (const volume of [
      {
        Name: "app-data",
        Labels: {
          "dev.lando.app": "app",
          "dev.lando.scope": "app",
          "dev.lando.store": "data",
          "dev.lando.volume-instance": "volume-instance-1",
        },
      },
    ])
      engine.assets.volumes.set(volume.Name, volume);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes[0]?.instanceId).toBe("volume-instance-1");
    expect(volumes[0]?.provenance).toBe("known");
  });

  test("includes legacy unlabeled volumes for exact app and store lookups", async () => {
    const engine = new FakeEngine();
    for (const volume of [{ Name: "data" }, { Name: "cache" }])
      engine.assets.volumes.set(volume.Name, volume);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app"), store: "data" }));

    expect(volumes).toEqual([{ ref: { app: AppId.make("app"), store: "data" }, provenance: "legacy" }]);
  });

  test("projects a validated adoption witness for an exact volume listing without writing the volume", async () => {
    // Given: an exact legacy volume whose explicit adoption elected a durable witness.
    const { api, requests } = makeWitnessVolumeApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
    });

    // When: a safety consumer performs an exact read-only list.
    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app"), store: "data" }));

    // Then: the elected generation is projected without an adoption/write command.
    expect(volumes).toEqual([
      {
        ref: { app: AppId.make("app"), store: "data" },
        identity: {
          coordinationKey: JSON.stringify(["endpoint:unix:///run/test.sock", "data"]),
          nativeName: "data",
          generation: adoptedGeneration,
          ownerRoot: adoptedOwnerRoot,
          origin: "adopted",
        },
        provenance: "legacy",
      },
    ]);
    const create = requests.find((request) => request.path.startsWith("/containers/create?name="));
    expect(create?.body).toMatchObject({ HostConfig: { Binds: ["data:/lando-data:ro"] } });
    expect(JSON.stringify(create?.body)).toContain('\\"operation\\":\\"read\\"');
    expect(JSON.stringify(create?.body)).not.toContain('\\"operation\\":\\"adopt\\"');
  });

  test("returns the elected adopted identity from targeted location", async () => {
    // Given: one witnessed legacy native volume.
    const { api } = makeWitnessVolumeApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
    });

    // When: a consumer locates its exact native volume.
    const located = await Effect.runPromise(provider.locateVolume({ app: AppId.make("app"), store: "data" }));

    // Then: the read-only path exposes the elected adoption identity.
    expect(located.identity).toEqual({
      coordinationKey: JSON.stringify(["endpoint:unix:///run/test.sock", "data"]),
      nativeName: "data",
      generation: adoptedGeneration,
      ownerRoot: adoptedOwnerRoot,
      origin: "adopted",
    });
  });

  test("keeps creation-label identity authoritative when a witness is also readable", async () => {
    // Given: a Lando-created volume carrying its complete creation fact.
    const { api, requests } = makeWitnessVolumeApi(adoptedGeneration, {
      "dev.lando.app": "app",
      "dev.lando.store": "data",
      "dev.lando.volume-instance": volumeGeneration,
      "dev.lando.volume-owner": String(adoptedOwnerRoot),
    });
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    // When: its exact identity is listed.
    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app"), store: "data" }));

    // Then: the creation generation and origin remain unchanged and no witness helper runs.
    expect(volumes[0]?.identity?.generation).toBe(volumeGeneration);
    expect(volumes[0]?.identity?.origin).toBe("created");
    expect(requests.some((request) => request.path.startsWith("/containers/create?name="))).toBe(false);
  });

  test("allows removal only while the elected witness generation still matches", async () => {
    // Given: an adopted volume and its current witness generation.
    const { api, requests } = makeWitnessVolumeApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
    });

    // When: removal rechecks the matching witness.
    await Effect.runPromise(
      provider.removeVolume({ app: AppId.make("app"), store: "data" }, adoptedGeneration),
    );

    // Then: the exact native volume is removed after the read-only recheck.
    expect(requests.some((request) => request.method === "DELETE" && request.path === "/volumes/data")).toBe(
      true,
    );
  });

  test.each([
    {
      status: 409,
      body: JSON.stringify({ message: "volume data is being used by container lando-orphan--db" }),
      reason: "lando-orphan--db",
    },
    {
      status: 500,
      body: JSON.stringify({ message: "volume data is in use by container orphan-db" }),
      reason: "orphan-db",
    },
    { status: 500, body: "volume data is in use by container plain-db", reason: "plain-db" },
    { status: 500, body: JSON.stringify({ message: "internal daemon error" }), reason: undefined },
  ])("explains volume users only for remove conflicts: $status $body", async ({ status, body, reason }) => {
    const engine = new FakeEngine().fail("volume.delete", { status, body });
    engine.assets.volumes.set("data", {
      Name: "data",
      Labels: { "dev.lando.volume-instance": volumeGeneration },
    });
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const result = await Effect.runPromise(
      provider.removeVolume({ app: appId, store: "data" }, volumeGeneration).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(VolumeOperationError);
    if (!(result.failure instanceof VolumeOperationError)) throw new Error("Expected volume failure");
    expect(result.failure.operation).toBe("removeVolume");
    if (reason === undefined) {
      expect(result.failure.details).toMatchObject({ status: 500 });
    } else {
      expect(result.failure.message).toContain(reason);
      expect(result.failure.remediation).toContain("Wait for any running data operation to finish");
      expect(result.failure.remediation).toContain("10 minutes");
      expect(result.failure.remediation).not.toContain("cannot verify");
    }
  });

  test("allows restore only while the elected witness generation still matches", async () => {
    // Given: an adopted target volume and a verified native snapshot.
    const { api, requests } = makeWitnessVolumeApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "native" },
      redactor: passthroughRedactor,
      pullHelperImage: echoHelperPull(),
    });

    // When: restore rechecks the matching witness before mutation.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.restoreVolume({
          snapshot: {
            provider: ProviderId.make("test"),
            id: "snapshot",
            digest: "sha256:snapshot",
            sizeBytes: bytes("snapshot").byteLength,
            format: "native",
          },
          target: { app: AppId.make("app"), store: "data" },
          expectedTargetGeneration: adoptedGeneration,
          overwrite: true,
        }),
      ),
    );

    // Then: identity verification passes and the restore helper receives the writable target.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.path.startsWith("/containers/create?name=") &&
          JSON.stringify(request.body).includes("data:/lando-data"),
      ),
    ).toBe(true);
  });

  test("invalidates an adopted identity when the native volume is deleted and recreated", async () => {
    // Given: a consumer holding the first elected generation before replacement.
    const { api, replace, requests } = makeWitnessVolumeApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      endpointNamespace: "unix:///run/test.sock",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    replace();

    // When: removal rechecks the stale generation against the replacement witness.
    const exit = await Effect.runPromiseExit(
      provider.removeVolume({ app: AppId.make("app"), store: "data" }, adoptedGeneration),
    );

    // Then: the replacement is preserved.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(requests.some((request) => request.method === "DELETE" && request.path === "/volumes/data")).toBe(
      false,
    );
  });

  test("fails service copy when the applied plan is unavailable", async () => {
    const calls: string[] = [];
    const engine = new FakeEngine();
    engine.onRequest = (request) => calls.push(request.path);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    const exit = await Effect.runPromiseExit(
      provider.copyToService(
        { app: appId, service: serviceName },
        {
          sourcePath: AbsolutePath.make(import.meta.path),
          targetPath: PortablePath.make("/tmp/payload"),
        },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    if (exit._tag === "Failure") {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ServiceCopyError);
    }
  });

  test("uses the plan slug for service copy container names", async () => {
    const calls: string[] = [];
    let uploadChunks = 0;
    const engine = new FakeEngine();
    engine.containers.create(
      { method: "POST", path: "/containers/create?name=lando-app-slug--web", body: { Image: "fixture" } },
      new URL("http://fake/containers/create?name=lando-app-slug--web"),
    );
    engine.onRequest = (request) => calls.push(request.path);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });

    await Effect.runPromise(
      provider.copyToService(
        { app: appId, service: serviceName, plan },
        {
          sourcePath: AbsolutePath.make(import.meta.path),
          targetPath: PortablePath.make("/tmp/payload"),
        },
      ),
    );

    expect(calls[0]).toContain("/containers/lando-app-slug--web/archive?");
    uploadChunks = engine.assets.uploadChunks;
    expect(uploadChunks).toBeGreaterThan(1);
  });
});

test.each([
  "",
  "{}",
  '{"State":{}}',
  '{"State":{"ExitCode":"0"}}',
  '{"State":{"ExitCode":0.5}}',
  '{"State":{"ExitCode":null}}',
  "PRIVATE MALFORMED JSON",
])("fails closed for invalid ephemeral exit inspection: %s", async (body) => {
  let removed = false;
  const engine = new FakeEngine().fail("container.inspect", { status: 200, body });
  engine.observers.set("container.delete", () => {
    removed = true;
  });
  const api = engine.api;
  const provider = makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "none" },
    redactor: passthroughRedactor,
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      provider.runStream({ image: "alpine:3.20", command: ["true"], remove: true }).pipe(Stream.runDrain),
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("Expected inspection failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(ProviderInternalError);
  expect(JSON.stringify(error)).not.toContain(body === "" ? "PRIVATE MALFORMED JSON" : body);
  expect(removed).toBe(true);
});

test.each(["http", "typed", "defect", "interrupt"] as const)(
  "preserves ephemeral inspection %s failure and closes the container",
  async (mode) => {
    let removals = 0;
    const engine = new FakeEngine();
    engine.observers.set("container.delete", () => {
      removals += 1;
    });
    const failure = (() => {
      switch (mode) {
        case "http":
          return Effect.succeed({ status: 500, body: "PRIVATE INSPECTION RESPONSE" });
        case "typed":
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: "test",
              operation: "inspect",
              message: "PRIVATE INSPECTION CAUSE",
              cause: "PRIVATE INSPECTION CAUSE",
              remediation: "Retry the fixture inspection.",
            }),
          );
        case "defect":
          return Effect.die({
            _tag: "TransportDefect",
            message: "PRIVATE INSPECTION DEFECT",
            cause: "PRIVATE INSPECTION DEFECT",
          });
        case "interrupt":
          return Effect.interrupt;
      }
    })();
    engine.inject("container.inspect", failure);
    const api = engine.api;
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.runStream({ image: "alpine:3.20", command: ["true"], remove: true }).pipe(Stream.runDrain),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected failed inspection");
    expect(removals).toBe(1);
    if (mode === "interrupt") {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    } else if (mode === "defect") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      const reason = exit.cause.reasons.find(Cause.isDieReason);
      expect(reason?.defect).toMatchObject({ _tag: "TransportDefect", message: "PRIVATE INSPECTION DEFECT" });
    } else if (mode === "typed") {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error).toMatchObject({
        operation: "inspect",
        remediation: "Retry the fixture inspection.",
        cause: "PRIVATE INSPECTION CAUSE",
      });
    } else {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      if (!(error instanceof ProviderUnavailableError))
        throw new Error("Expected unavailable inspection error");
      expect(JSON.stringify(error)).not.toContain("PRIVATE INSPECTION");
      expect(error.details).toEqual({ status: 500 });
      expect(error.cause).toBeUndefined();
    }
  },
);

describe("borrowed ephemeral mounts", () => {
  const runBorrowed = async (subpath?: string | null, readOnly = false) => {
    const requests: Parameters<NonNullable<DataPlaneApiClient["request"]>>[0][] = [];
    const provider = makeProviderDataPlane({
      providerId: "docker",
      capabilities: { volumeSnapshot: "none" },
      redactor: passthroughRedactor,
      api: {
        request: (request) => {
          requests.push(request);
          if (request.path === "/containers/source-container/json")
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({
                HostConfig: {
                  Mounts:
                    subpath === null
                      ? null
                      : [
                          {
                            Type: "volume",
                            Target: "/app",
                            VolumeOptions: subpath === undefined ? {} : { Subpath: subpath },
                          },
                        ],
                },
              }),
            });
          return Effect.succeed(
            request.path.endsWith("/json")
              ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
              : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
          );
        },
        stream: () => Stream.empty,
      },
    });
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        provider.run({
          image: "sqlite-helper",
          command: ["true"],
          remove: true,
          mountsFrom: { containerId: "source-container", readOnly },
          binds: [{ source: "/private/scratch", target: "/sql-scratch" }],
          user: "100:200",
          entrypoint: [],
        }),
      ),
    );
    return { result, requests };
  };

  test.each([true, false])(
    "combines realized service mounts with an explicit scratch bind (readOnly=%s)",
    async (readOnly) => {
      const { result, requests } = await runBorrowed(undefined, readOnly);
      expect(Exit.isSuccess(result)).toBe(true);
      const create = requests.find((request) => request.path.startsWith("/containers/create?"));
      expect(create?.minimumApiVersion).toBeUndefined();
      expect(create?.body).toMatchObject({
        HostConfig: {
          Binds: [],
          VolumesFrom: [`source-container:${readOnly ? "ro" : "rw"}`],
          Mounts: [{ Type: "bind", Source: "/private/scratch", Target: "/sql-scratch", ReadOnly: false }],
        },
      });
      expect(
        requests
          .filter((request) => request !== create)
          .every((request) => request.minimumApiVersion === undefined),
      ).toBe(true);
    },
  );

  test("accepts a source whose inspect represents absent long-syntax mounts as null", async () => {
    const { result } = await runBorrowed(null);
    expect(Exit.isSuccess(result)).toBe(true);
  });

  test("refuses borrowed volume subpaths before create rather than mounting their root", async () => {
    const { result, requests } = await runBorrowed("tenant");
    expect(Exit.isFailure(result)).toBe(true);
    if (!Exit.isFailure(result)) return;
    const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause));
    expect(failure).toBeInstanceOf(ProviderCapabilityError);
    if (!(failure instanceof ProviderCapabilityError)) return;
    expect(failure.capability).toBe("volume-subpath");
    expect(requests.some((request) => request.path.endsWith("/start"))).toBe(false);
    expect(requests.filter((request) => request.path.startsWith("/containers/create?"))).toHaveLength(0);
  });
});

for (const mode of ["run", "runStream"] as const) {
  test.each([200, 201, 409, 202, 204, 500, 503])(
    `${mode} classifies ephemeral volume HTTP %s before acquiring container`,
    async (status) => {
      const requests: Array<{ method: string; path: string }> = [];
      const privateBody = "unregistered-volume-body".repeat(50000);
      const engine = new FakeEngine().fail("volume.create", { status, body: privateBody });
      engine.onRequest = (input) => requests.push(input);
      const provider = makeProviderDataPlane({
        providerId: "test",
        redactor: passthroughRedactor,
        capabilities: { volumeSnapshot: "none" },
        api: engine.api,
      });
      const work = {
        image: "fixture",
        command: ["true"],
        remove: true,
        owner: {
          app: appId,
          plan: {
            ...plan,
            identity: { appRoot: AbsolutePath.make("/canonical/app"), ownerKey: "canonical-app" },
            stores: [{ name: "data", scope: "app" as const, kind: "data" as const }],
          },
        },
        mounts: [
          { type: "volume" as const, store: "data", target: PortablePath.make("/data"), readOnly: false },
        ],
      };
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "run"
            ? provider.run(work).pipe(Effect.asVoid)
            : provider.runStream(work).pipe(Stream.runDrain),
        ),
      );
      if ([200, 201, 409].includes(status)) {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) throw new Error("Expected failure");
        const failures = exit.cause.reasons.filter(Cause.isFailReason);
        expect(failures[0]?.error).toBeInstanceOf(ProviderUnavailableError);
        expect(failures[0]?.error).toMatchObject({ operation: "run.volume", details: { status } });
        expect(JSON.stringify(failures[0]?.error)).not.toContain("unregistered-volume-body");
        expect(requests).toHaveLength(1);
      }
    },
  );
}

const volumeMount = {
  type: "volume" as const,
  store: "data",
  target: PortablePath.make("/data"),
  readOnly: false,
};
const volumeRunSpec = {
  image: "fixture",
  command: ["true"],
  remove: true,
  owner: {
    app: appId,
    plan: {
      ...plan,
      identity: { appRoot: AbsolutePath.make("/canonical/app"), ownerKey: "canonical-app" },
      stores: [
        { name: "data", scope: "app" as const, kind: "data" as const },
        { name: "other", scope: "app" as const, kind: "data" as const },
      ],
    },
  },
  mounts: [{ type: "volume" as const, store: "data", target: PortablePath.make("/data"), readOnly: false }],
};
for (const mode of ["run", "runStream"] as const) {
  test.each(["typed", "defect", "interrupt", "partial"] as const)(
    `${mode} preserves volume ingress %s and never cleans unacquired containers or named stores`,
    async (phase) => {
      const original = new ProviderCapabilityError({
        providerId: "test",
        operation: "fixture.original",
        message: "Unavailable",
        remediation: "Choose supported volume storage",
        capability: "volume",
        requiredValue: "named",
        actualValue: "none",
        cause: { debug: true },
      });
      const defect = { arbitrary: "defect" };
      const requests: Array<{ method: string; path: string }> = [];
      const engine = new FakeEngine();
      engine.onRequest = (input) => requests.push(input);
      if (phase === "partial") {
        engine.fail("volume.create", { status: 201, body: "private-body" });
        engine.fail("volume.create", { status: 503, body: "private-body" });
      } else
        engine.inject(
          "volume.create",
          phase === "typed"
            ? Effect.fail(original)
            : phase === "defect"
              ? Effect.die(defect)
              : Effect.interrupt,
        );
      const provider = makeProviderDataPlane({
        providerId: "test",
        redactor: passthroughRedactor,
        capabilities: { volumeSnapshot: "none" },
        api: engine.api,
      });
      const work =
        phase === "partial"
          ? {
              ...volumeRunSpec,
              mounts: [...volumeRunSpec.mounts, { ...volumeMount, store: "other" }],
            }
          : volumeRunSpec;
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "run"
            ? provider.run(work).pipe(Effect.asVoid)
            : provider.runStream(work).pipe(Stream.runDrain),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      expect(requests.every((input) => input.path === "/volumes/create" && input.method === "POST")).toBe(
        true,
      );
      expect(requests).toHaveLength(phase === "partial" ? 2 : 1);
      if (phase === "typed") {
        const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(error).toBeInstanceOf(ProviderCapabilityError);
        expect(error).toMatchObject({
          operation: original.operation,
          remediation: original.remediation,
          cause: original.cause,
        });
      } else if (phase === "defect") expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
      else if (phase === "interrupt") expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
      else
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(ProviderUnavailableError);
    },
  );

  test.each(["owner", "plan", "identity", "app", "store"] as const)(
    `${mode} retains ownership error for missing or mismatched %s`,
    async (field) => {
      let requests = 0;
      const engine = new FakeEngine();
      engine.onRequest = () => {
        requests++;
      };
      const provider = makeProviderDataPlane({
        providerId: "test",
        redactor: passthroughRedactor,
        capabilities: { volumeSnapshot: "none" },
        api: engine.api,
      });
      const { identity: _identity, ...withoutIdentity } = volumeRunSpec.owner.plan;
      const { owner: _owner, ...withoutOwner } = volumeRunSpec;
      const work = {
        ...withoutOwner,
        ...(field === "owner"
          ? {}
          : {
              owner:
                field === "plan"
                  ? { app: appId }
                  : field === "identity"
                    ? { app: appId, plan: withoutIdentity }
                    : field === "app"
                      ? { ...volumeRunSpec.owner, app: AppId.make("different") }
                      : volumeRunSpec.owner,
            }),
        mounts: field === "store" ? [{ ...volumeMount, store: "undeclared" }] : volumeRunSpec.mounts,
      };
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "run"
            ? provider.run(work).pipe(Effect.asVoid)
            : provider.runStream(work).pipe(Stream.runDrain),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(error).toBeInstanceOf(VolumeOperationError);
      if (!(error instanceof VolumeOperationError)) throw new Error("Expected volume ownership failure");
      expect(error.details).toEqual(
        field === "owner"
          ? undefined
          : field === "store"
            ? { app: String(appId), store: "undeclared" }
            : { app: String(work.owner?.app) },
      );
      expect(requests).toBe(0);
    },
  );
}

for (const mode of ["run", "runStream"] as const) {
  test.each([false, true])(
    `${mode} mounted run safely returns cleanup diagnostics after acquisition (primary=%s)`,
    async (primary) => {
      const secret = "mounted-error-secret-key";
      const service = makeRedactionService();
      await Effect.runPromise(service.registerValues([secret]));
      const redactor = await Effect.runPromise(service.forProfile("secrets"));
      const error = () => {
        const failure = new ProviderUnavailableError({
          providerId: "test",
          operation: "fixture.original",
          message: "Unavailable",
          remediation: "Run doctor",
        });
        Object.defineProperty(failure, "details", {
          value: {
            [secret]: "hidden",
            safe: { status: 503 },
            error: Object.assign(new Error(secret), { name: secret }),
          },
        });
        return failure;
      };
      let removals = 0;
      const engine = new FakeEngine().fail("container.delete", error());
      engine.observers.set("container.delete", () => {
        removals++;
      });
      if (primary) engine.fail("container.start", error());
      engine.assets.volumes.set("data", { Name: "data" });
      const provider = makeProviderDataPlane({
        providerId: "test",
        redactor,
        capabilities: { volumeSnapshot: "none" },
        api: engine.api,
      });
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "run"
            ? provider.run(volumeRunSpec).pipe(Effect.asVoid)
            : provider.runStream(volumeRunSpec).pipe(Stream.runDrain),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      expect(removals).toBe(1);
      const outcome = failureOutcomeFromCause(exit.cause);
      const errors = [outcome.error, ...outcome.additionalErrors.map(({ error }) => error)];
      expect(errors).toHaveLength(primary ? 2 : 1);
      for (const failure of errors) {
        expect(failure).toBeInstanceOf(ProviderUnavailableError);
        const json = taggedErrorJson(failure);
        expect(JSON.stringify(json)).not.toContain(secret);
        expect(json.details).toMatchObject({
          safe: { status: 503 },
          error: { name: "[redacted]", message: "[redacted]" },
        });
      }
      if (primary) expect(outcome.additionalErrors[0]?.role).toBe("cleanup");
    },
  );
}
