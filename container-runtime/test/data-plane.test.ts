import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { ArtifactTransferError, ServiceCopyError, VolumeOperationError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

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

const makeCopySnapshotApi = () => {
  const containers = new Map<
    string,
    {
      readonly body: { Cmd?: ReadonlyArray<string>; HostConfig?: { Binds?: ReadonlyArray<string> } };
      exitCode: number;
    }
  >();
  const volumes = new Map<string, Uint8Array>([["data", bytes("original")]]);
  const snapshotFiles = new Map<string, Uint8Array>();
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.sync(() => {
        if (request.path === "/volumes/data") {
          return {
            status: 200,
            body: JSON.stringify({
              Name: "data",
              Labels: { "dev.lando.volume-instance": volumeGeneration },
            }),
          };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          containers.set(name, { body: request.body as never, exitCode: 0 });
          return { status: 201, body: "{}" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          const container = containers.get(name);
          const command = container?.body.Cmd?.join(" ") ?? "";
          const binds = container?.body.HostConfig?.Binds ?? [];
          const dataStore = binds[0]?.split(":")[0];
          const snapshotStore = binds[1]?.split(":")[0];
          if (container !== undefined && dataStore !== undefined && snapshotStore !== undefined) {
            if (command.includes("tar -C /lando-data -cf") && !command.includes("lando-restore")) {
              snapshotFiles.set(`${snapshotStore}/snap.tar`, volumes.get(dataStore) ?? new Uint8Array());
            } else if (command.includes("lando-restore") && command.includes("tar -C /lando-data -xf")) {
              const snapshot = snapshotFiles.get(`${snapshotStore}/snap.tar`);
              const expectedDigest = container.body.Cmd?.at(-2);
              const expectedSize = Number(container.body.Cmd?.at(-1));
              if (
                snapshot === undefined ||
                sha256(snapshot) !== expectedDigest ||
                snapshot.byteLength !== expectedSize
              ) {
                container.exitCode = 1;
              } else volumes.set(dataStore, snapshot);
            }
          }
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/wait")) {
          return { status: 200, body: JSON.stringify({ StatusCode: 0 }) };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          return {
            status: 200,
            body: JSON.stringify({ State: { ExitCode: containers.get(name)?.exitCode ?? 0 } }),
          };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("?force=true")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: "{}" };
      }),
    stream: (request) =>
      request.path.includes("/logs?")
        ? Stream.make(multiplexedStdoutFrame(bytes(`${sha256(bytes("original"))} 8\n`)))
        : Stream.empty,
  };
  return { api, volumes, snapshotFiles };
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });
    const source = Stream.concat(Stream.make(bytes("first")), Stream.fail(sourceError));

    // When: the provider consumes the failing producer.
    const exit = await Effect.runPromiseExit(provider.importArtifact(source));

    // Then: the import fails instead of returning an image reference.
    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ArtifactTransferError);
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const exit = await Effect.runPromiseExit(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ArtifactTransferError);
    }
  });

  test("treats native snapshot wait responses without StatusCode as successful", async () => {
    const paths: string[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        paths.push(request.path);
        if (request.path.startsWith("/commit?")) {
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
      snapshotMode: "native",
      redactDetails: (value) => value,
    });

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({ volume: { app: AppId.make("app"), store: "data" }, snapshotId: "snap" }),
      ),
    );

    expect(snapshot.provider).toBe(ProviderId.make("test"));
    expect(snapshot.id).toBe("snap");
    expect(snapshot).toMatchObject({ digest: "sha256:native-snapshot", sizeBytes: 4096, format: "native" });
    expect(paths.some((path) => path.includes("/commit?"))).toBe(true);
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
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

  test("persists copy-mode snapshots in a provider volume across data-plane instances", async () => {
    const fake = makeCopySnapshotApi();
    const firstProvider = makeProviderDataPlane({
      providerId: "test",
      api: fake.api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });
    const secondProvider = makeProviderDataPlane({
      providerId: "test",
      api: fake.api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        firstProvider.snapshotVolume({
          volume: { app: AppId.make("app"), store: "data" },
          snapshotId: "snap",
        }),
      ),
    );

    expect(snapshot).toMatchObject({
      digest: sha256(bytes("original")),
      sizeBytes: bytes("original").byteLength,
      format: "tar",
    });
    fake.volumes.set("data", bytes("changed"));
    await Effect.runPromise(
      Effect.scoped(
        secondProvider.restoreVolume({
          snapshot,
          target: { app: AppId.make("app"), store: "data" },
          expectedTargetGeneration: volumeGeneration,
        }),
      ),
    );

    expect(text(fake.volumes.get("data") ?? new Uint8Array())).toBe("original");
  });

  test("preserves existing copy-mode volume data when restore overwrite is false", async () => {
    const fake = makeCopySnapshotApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      api: fake.api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({
          volume: { app: AppId.make("app"), store: "data" },
          snapshotId: "snap",
        }),
      ),
    );
    fake.volumes.set("data", bytes("changed"));
    await Effect.runPromise(
      Effect.scoped(
        provider.restoreVolume({
          snapshot,
          target: { app: AppId.make("app"), store: "data" },
          expectedTargetGeneration: volumeGeneration,
          overwrite: false,
        }),
      ),
    );

    expect(text(fake.volumes.get("data") ?? new Uint8Array())).toBe("changed");
  });

  test("rejects changed copy snapshot bytes before target mutation", async () => {
    // Given: a completed copy snapshot whose provider-owned archive is changed afterward.
    const fake = makeCopySnapshotApi();
    const provider = makeProviderDataPlane({
      providerId: "test",
      api: fake.api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({ volume: { app: AppId.make("app"), store: "data" }, snapshotId: "snap" }),
      ),
    );
    fake.snapshotFiles.set("lando-test-copy-snapshots/snap.tar", bytes("tampered"));
    fake.volumes.set("data", bytes("target-before-restore"));

    // When: restore checks the immutable source artifact and target generation.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.restoreVolume({
          snapshot,
          target: { app: AppId.make("app"), store: "data" },
          expectedTargetGeneration: volumeGeneration,
        }),
      ),
    );

    // Then: the helper fails without replacing the target bytes.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(text(fake.volumes.get("data") ?? new Uint8Array())).toBe("target-before-restore");
  });

  test("rejects restore and removal when the observed volume generation changed", async () => {
    const mutations: string[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
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
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });
    const staleGeneration = "00000000-0000-4000-8000-000000000002";

    const restore = await Effect.runPromiseExit(
      Effect.scoped(
        provider.restoreVolume({
          snapshot: {
            provider: ProviderId.make("test"),
            id: "snap",
            digest: "missing",
            sizeBytes: 0,
            format: "tar",
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
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app") }));

    expect(volumes.map((volume) => volume.ref.store)).toEqual(["data"]);
    expect(volumes[0]?.instanceId).toBe("volume-instance-1");
    expect(volumes[0]?.provenance).toBe("known");
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
      snapshotMode: "copy",
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
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const volumes = await Effect.runPromise(provider.listVolumes({ app: AppId.make("app"), store: "data" }));

    expect(volumes).toEqual([{ ref: { app: AppId.make("app"), store: "data" }, provenance: "legacy" }]);
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
      snapshotMode: "copy",
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
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ServiceCopyError);
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
      snapshotMode: "copy",
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
