import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { ServiceCopyError, VolumeOperationError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

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

const multiplexedStdoutFrame = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
};

const appId = AppId.make("app-id");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("test");
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
            if (command.includes("tar -C /lando-data -cf /lando-snapshots/snap.tar .")) {
              snapshotFiles.set(`${snapshotStore}/snap.tar`, volumes.get(dataStore) ?? new Uint8Array());
            } else if (command.includes("tar -C /lando-data -xf /lando-snapshots/snap.tar")) {
              const snapshot = snapshotFiles.get(`${snapshotStore}/snap.tar`);
              if (snapshot === undefined) container.exitCode = 1;
              else volumes.set(dataStore, snapshot);
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
  };
  return { api, volumes };
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

  test("treats native snapshot wait responses without StatusCode as successful", async () => {
    const paths: string[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        paths.push(request.path);
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
        Stream.fromAsyncIterable(
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
        ),
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
      stream: () => {
        attachCalled = true;
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
    fake.volumes.set("data", bytes("changed"));
    await Effect.runPromise(
      Effect.scoped(
        secondProvider.restoreVolume({ snapshot, target: { app: AppId.make("app"), store: "data" } }),
      ),
    );

    expect(text(fake.volumes.get("data") ?? new Uint8Array())).toBe("original");
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
                Labels: { "dev.lando.app": "app", "dev.lando.scope": "app", "dev.lando.store": "data" },
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
  });
});
