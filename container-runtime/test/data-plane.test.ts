import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Stream } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import {
  ArtifactTransferError,
  ProviderCapabilityError,
  ServiceCopyError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

import {
  HISTORY_MODE_INSTANCE_LABEL,
  HISTORY_MODE_LABEL,
  HISTORY_MODE_VERIFIED,
} from "../src/volume-history-helper.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

const stdinBytes = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes(value);
  },
});

const collectAsyncBytes = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
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

const multiplexedStdoutFrame = (payload: Uint8Array): Uint8Array => multiplexedFrame("stdout", payload);
const multiplexedStderrFrame = (payload: Uint8Array): Uint8Array => multiplexedFrame("stderr", payload);

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
      const plane = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: capability },
        redactDetails: (value) => value,
        api: {
          request: () => {
            requests += 1;
            return Effect.succeed({ status: 204, body: "" });
          },
        },
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
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactDetails: (value) => value,
      api: {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
          return Effect.succeed({ status, body: "" });
        },
      },
    });
    await Effect.runPromise(Effect.scoped(plane.removeVolumeSnapshot(removableSnapshot)));
    expect(requests).toEqual(["DELETE /images/localhost%2Flando-volume-snapshot%3Asnap-name"]);
  });

  test("native removal fails tagged on an image in use", async () => {
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactDetails: (value) => value,
      api: { request: () => Effect.succeed({ status: 409, body: "image in use" }) },
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
    const plane = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactDetails: (value) => value,
      api: {
        request: () => {
          requests += 1;
          return Effect.succeed({ status: 204, body: "" });
        },
      },
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
  networks: [],
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
  let generation = initialGeneration;
  const requests: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> = [];
  const volume = () => ({
    Name: "data",
    Driver: "local",
    Options: {},
    ...(Object.keys(labels).length === 0 ? {} : { Labels: labels }),
  });
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        if (request.path === "/volumes" && request.method === "GET") {
          return Effect.succeed({ status: 200, body: JSON.stringify({ Volumes: [volume()] }) });
        }
        if (request.path === "/volumes/data" && request.method === "GET") {
          return Effect.succeed({ status: 200, body: JSON.stringify(volume()) });
        }
        if (request.path === "/containers/service/json") {
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({ Mounts: [{ Type: "volume", Destination: "/data", Name: "data" }] }),
          });
        }
        if (request.path.startsWith("/images/"))
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({ Id: "sha256:snapshot", Size: 8 }),
          });
        if (request.path.startsWith("/containers/create?name=")) {
          return Effect.succeed({ status: 201, body: "{}" });
        }
        if (request.path.endsWith("/wait")) {
          return Effect.succeed({ status: 200, body: JSON.stringify({ StatusCode: 0 }) });
        }
        if (request.path.endsWith("/json")) {
          return Effect.succeed({ status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) });
        }
        return Effect.succeed({ status: 204, body: "" });
      }),
    stream: (request) =>
      request.path.includes("/logs?")
        ? Stream.make(
            multiplexedStdoutFrame(
              bytes(`${JSON.stringify({ version: 1, generation, ownerRoot: adoptedOwnerRoot })}\n`),
            ),
          )
        : Stream.empty,
  };
  return {
    api,
    requests,
    replace: () => {
      generation = replacementGeneration;
    },
  };
};

describe("provider data plane", () => {
  test("imports artifacts from newline-delimited provider load progress", async () => {
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: `${JSON.stringify({ stream: "Loading layer 1/1\n" })}\n${JSON.stringify({ stream: "Loaded image: example/app:latest\n" })}\n`,
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    });
    const source = Stream.fromAsyncIterable(
      (async function* () {
        yield bytes("first");
        if (!requestStarted) throw sourceError;
        yield bytes("second");
      })(),
      (cause) => (cause instanceof ArtifactTransferError ? cause : sourceError),
    );
    const api: DataPlaneApiClient = {
      request: (request) => {
        requestStarted = true;
        return Effect.tryPromise({
          try: async () => {
            uploaded = text(await collectAsyncBytes(request.stdin));
            return { status: 200, body: JSON.stringify({ aux: { ID: "sha256:streamed" } }) };
          },
          catch: (cause) =>
            new ArtifactTransferError({
              providerId: "test",
              operation: "importArtifact",
              message: "Failed to consume artifact upload.",
              cause,
            }),
        });
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    // When: the artifact is imported through the provider data plane.
    const ref = await Effect.runPromise(provider.importArtifact(source));

    // Then: request consumption and producer emission interleave without buffering the payload first.
    expect(uploaded).toBe("firstsecond");
    expect(ref.ref).toBe("sha256:streamed");
  });

  test("streams an artifact larger than two GiB through the provider request", async () => {
    // Given: a reusable one-MiB chunk emitted enough times to cross the signed 32-bit boundary.
    const chunk = new Uint8Array(1024 * 1024);
    const chunkCount = 2049;
    const source = Stream.fromIterable(Array.from({ length: chunkCount })).pipe(Stream.map(() => chunk));
    let uploadedBytes = 0;
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.promise(async () => {
          if (request.stdin !== undefined) {
            for await (const part of request.stdin) uploadedBytes += part.byteLength;
          }
          return { status: 200, body: JSON.stringify({ aux: { ID: "sha256:large" } }) };
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    // When: the real artifact-import path forwards the source to the provider API.
    const ref = await Effect.runPromise(provider.importArtifact(source));

    // Then: every byte crosses the production boundary without a whole-payload allocation.
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
    });
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.tryPromise({
          try: async () => {
            await collectAsyncBytes(request.stdin);
            return { status: 200, body: JSON.stringify({ aux: { ID: "sha256:unreachable" } }) };
          },
          catch: (cause) =>
            new ArtifactTransferError({
              providerId: "test",
              operation: "importArtifact",
              message: "Artifact upload failed.",
              cause,
            }),
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: `${JSON.stringify({ stream: "Loading layer 1/1\n" })}\n${JSON.stringify({ aux: { ID: "sha256:abc123" } })}\n`,
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    const ref = await Effect.runPromise(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(ref.ref).toBe("sha256:abc123");
  });

  test("fails artifact imports when the provider omits an image ref", async () => {
    const api: DataPlaneApiClient = {
      request: () => Effect.succeed({ status: 200, body: JSON.stringify({ stream: "Loading layer 1/1\n" }) }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    const exit = await Effect.runPromiseExit(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure") {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ArtifactTransferError);
    }
  });

  test("treats native snapshot wait responses without StatusCode as successful", async () => {
    const paths: string[] = [];
    const commits: unknown[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        paths.push(request.path);
        if (request.path.startsWith("/commit?")) {
          commits.push(request.body);
          return Effect.succeed({ status: 201, body: JSON.stringify({ Id: "sha256:native-snapshot" }) });
        }
        if (request.path.startsWith("/images/")) {
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({ Id: "sha256:native-snapshot", Size: 4096 }),
          });
        }
        if (request.path.includes("/wait")) return Effect.succeed({ status: 200, body: "{}" });
        return Effect.succeed({ status: request.method === "DELETE" ? 204 : 201, body: "{}" });
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "native" },
      redactDetails: (value) => value,
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

  test("closes ephemeral attach streams after stdin is consumed", async () => {
    let attached = "";
    let attachAborted = false;
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        ),
      stream: (request) =>
        request.path.includes("/attach?")
          ? Stream.fromAsyncIterable(
              (async function* () {
                attached = text(await collectAsyncBytes(request.stdin));
                attachAborted = request.signal?.aborted === true;
                yield new Uint8Array();
              })(),
              (cause) =>
                new VolumeOperationError({
                  providerId: "test",
                  operation: "run.attach",
                  message: "Failed to collect stdin.",
                  remediation: "Retry the test.",
                  cause,
                }),
            )
          : Stream.empty,
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["cat"],
          stdinStream: stdinBytes("streamed stdin"),
          remove: true,
        }),
      ),
    );

    expect(attached).toBe("streamed stdin");
    expect(attachAborted).toBe(true);
  });

  test("does not leave ephemeral stdin open without a forwarded stream", async () => {
    let createBody: { OpenStdin?: boolean; AttachStdin?: boolean; StdinOnce?: boolean } | undefined;
    let attachCalled = false;
    const api: DataPlaneApiClient = {
      request: (request) => {
        if (request.path.startsWith("/containers/create?name=")) createBody = request.body as never;
        return Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        );
      },
      stream: (request) => {
        if (request.path.includes("/attach?")) attachCalled = true;
        return Stream.empty;
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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

    expect(createBody).toMatchObject({ OpenStdin: false, AttachStdin: false, StdinOnce: false });
    expect(attachCalled).toBe(false);
  });

  test("creates owned data-store volumes before ephemeral containers", async () => {
    // Given: an app-owned store and a provider API that records creation order and payloads.
    const requests: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        requests.push(request);
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
      redactDetails: (value) => value,
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
      mounts: [{ store: "data", target: PortablePath.make("/data"), readOnly: false }],
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
  });

  test("preserves colon targets in ephemeral API Mounts", async () => {
    // Given
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
      redactDetails: (value) => value,
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
            { store: "data", target: PortablePath.make("/data:ro"), readOnly: true },
            { store: "data", target: PortablePath.make("/ordinary"), readOnly: false },
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

  test("adopts an existing ephemeral volume without treating submitted labels as observed", async () => {
    // Given: the daemon reports that the declared volume already exists.
    const requests: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        requests.push(request);
        if (request.path === "/volumes/create") return Effect.succeed({ status: 409, body: "{}" });
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
      redactDetails: (value) => value,
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
          mounts: [{ store: "data", target: PortablePath.make("/data"), readOnly: false }],
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
    const provider = makeProviderDataPlane({
      providerId: "test",
      api: {
        request: (request) => {
          requests.push(request.path);
          return Effect.succeed({ status: 201, body: "{}" });
        },
        stream: () => Stream.empty,
      },
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    // When: the caller asks to mount a named data store.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.run({
          owner: { app: appId },
          image: "alpine:3.20",
          command: ["true"],
          mounts: [{ store: "data", target: PortablePath.make("/data"), readOnly: false }],
        }),
      ),
    );

    // Then: no daemon mutation is attempted without an applied canonical plan.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(requests).toEqual([]);
  });

  test("decodes Docker multiplexed stdout frames with big-endian lengths", async () => {
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        ),
      stream: () => Stream.make(multiplexedStdoutFrame(bytes("hello from logs"))),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) => {
        paths.push(request.path);
        return Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 1 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        );
      },
      stream: (request) => {
        paths.push(request.path);
        return Stream.make(multiplexedStderrFrame(bytes("helper failed")));
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 1 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        ),
      stream: () =>
        Stream.make(multiplexedStdoutFrame(bytes("stdout")), multiplexedStderrFrame(bytes("stderr"))),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) => {
        if (request.path.endsWith("/wait")) waited = true;
        return Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        );
      },
      stream: () => Stream.make(multiplexedStdoutFrame(bytes("first"))),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) => {
        if (request.path.startsWith("/images/") && request.method === "GET") {
          return Effect.succeed({ status: 200, body: JSON.stringify({ Id: "sha256:snapshot", Size: 0 }) });
        }
        if (request.path === "/volumes/data" && request.method === "GET") {
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({
              Name: "data",
              Labels: { "dev.lando.volume-instance": volumeGeneration },
            }),
          });
        }
        return Effect.sync(() => {
          mutations.push(`${request.method} ${request.path}`);
          return { status: 204, body: "" };
        });
      },
      stream: () => Stream.empty,
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "native" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: JSON.stringify({
            Volumes: [
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
            ],
          }),
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes.map((volume) => volume.ref.store)).toEqual(["data"]);
    expect(volumes[0]?.instanceId).toBe("volume-instance-1");
    expect(volumes[0]?.provenance).toBe("known");
  });

  test("keeps history mode marker volumes in provider inventory", async () => {
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: JSON.stringify({
            Volumes: [
              {
                Name: "lando-app-history",
                Labels: {
                  "dev.lando.app": "app",
                  "dev.lando.scope": "app",
                  "dev.lando.store": "lando-app-history",
                  "dev.lando.volume-instance": "store-instance-1",
                },
              },
              {
                Name: "lando-app-history.verified",
                Labels: {
                  "dev.lando.app": "app",
                  "dev.lando.scope": "app",
                  "dev.lando.store": "lando-app-history.verified",
                  "dev.lando.volume-instance": "marker-instance-1",
                  [HISTORY_MODE_LABEL]: HISTORY_MODE_VERIFIED,
                  [HISTORY_MODE_INSTANCE_LABEL]: "store-instance-1",
                },
              },
            ],
          }),
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes.map((volume) => volume.ref.store)).toEqual([
      "lando-app-history",
      "lando-app-history.verified",
    ]);
  });

  test("reads Podman bare-array volume listings", async () => {
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: JSON.stringify([
            {
              Name: "app-data",
              Labels: {
                "dev.lando.app": "app",
                "dev.lando.scope": "app",
                "dev.lando.store": "data",
                "dev.lando.volume-instance": "volume-instance-1",
              },
            },
          ]),
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes[0]?.instanceId).toBe("volume-instance-1");
    expect(volumes[0]?.provenance).toBe("known");
  });

  test("includes legacy unlabeled volumes for exact app and store lookups", async () => {
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: JSON.stringify({
            Volumes: [{ Name: "data" }, { Name: "cache" }],
          }),
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
      redactDetails: (value) => value,
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
      redactDetails: (value) => value,
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
      redactDetails: (value) => value,
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
      redactDetails: (value) => value,
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
      body: JSON.stringify({ message: "volume data is being used by container lando-orphan-db" }),
      reason: "lando-orphan-db",
    },
    {
      status: 500,
      body: JSON.stringify({ message: "volume data is in use by container orphan-db" }),
      reason: "orphan-db",
    },
    { status: 500, body: "volume data is in use by container plain-db", reason: "plain-db" },
    { status: 500, body: JSON.stringify({ message: "internal daemon error" }), reason: undefined },
  ])("explains volume users only for remove conflicts: $status $body", async ({ status, body, reason }) => {
    const api: DataPlaneApiClient = {
      request: (input) =>
        Effect.succeed(
          input.method === "GET"
            ? {
                status: 200,
                body: JSON.stringify({
                  Name: "data",
                  Labels: { "dev.lando.volume-instance": volumeGeneration },
                }),
              }
            : { status, body },
        ),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
    });
    const result = await Effect.runPromise(
      provider.removeVolume({ app: appId, store: "data" }, volumeGeneration).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(VolumeOperationError);
    expect(result.failure.operation).toBe("removeVolume");
    if (reason === undefined) {
      expect(result.failure.message).toBe("Provider volume remove failed.");
      expect(result.failure.remediation).toBe(
        "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
      );
    } else {
      expect(result.failure.message).toContain(reason);
      expect(result.failure.remediation).toContain("Remove that container first");
      expect(result.failure.remediation).toContain("lando destroy");
      expect(result.failure.remediation).toContain("lando doctor");
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
      redactDetails: (value) => value,
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
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) => {
        calls.push(request.path);
        return Effect.succeed({ status: 200, body: "{}" });
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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
    const api: DataPlaneApiClient = {
      request: (request) => {
        calls.push(request.path);
        return Effect.promise(async () => {
          if (request.stdin !== undefined) {
            for await (const _chunk of request.stdin) uploadChunks += 1;
          }
          return { status: 200, body: "{}" };
        });
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactDetails: (value) => value,
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

    expect(calls[0]).toContain("/containers/lando-app-slug-web/archive?");
    expect(uploadChunks).toBeGreaterThan(1);
  });
});
