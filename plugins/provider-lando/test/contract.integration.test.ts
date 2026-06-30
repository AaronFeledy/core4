import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import { ServiceCopyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ServiceName } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import {
  runProviderContract,
  runProviderContractMatrix,
  runProviderDataPlaneContract,
} from "@lando/sdk/test";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const textEncoder = new TextEncoder();

const attachFrame = (stream: 1 | 2, text: string) => {
  const payload = textEncoder.encode(text);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = stream;
  frame[4] = (payload.length >>> 24) & 0xff;
  frame[5] = (payload.length >>> 16) & 0xff;
  frame[6] = (payload.length >>> 8) & 0xff;
  frame[7] = payload.length & 0xff;
  frame.set(payload, 8);
  return frame;
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const execs = new Map<string, number>();
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);

        if (request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.path === "/networks/lando-myapp" && request.method === "DELETE") {
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/exec/") && request.path.endsWith("/json") && request.method === "GET") {
          const execId = decodeURIComponent(request.path.slice("/exec/".length, -"/json".length));
          if (!execs.has(execId)) {
            return { status: 404, body: "" };
          }
          return { status: 200, body: JSON.stringify({ ExitCode: execs.get(execId) }) };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          existing.add(name);
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
        }
        if (request.path.endsWith("/exec") && request.method === "POST") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/exec".length));
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          const execId = `${name}-exec`;
          execs.set(execId, 0);
          return { status: 201, body: JSON.stringify({ Id: execId }) };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          existing.add(name);
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length));
          const wasRunning = running.delete(name);
          return { status: wasRunning ? 204 : 304, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"?force=true".length));
          const existed = existing.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }

          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "stopped" },
            }),
          };
        }

        return {
          status: 500,
          body: JSON.stringify({ error: `unhandled ${request.method} ${request.path}` }),
        };
      }),
    stream: (request) => {
      calls.push(request);
      if (request.path.startsWith("/exec/") && request.path.endsWith("/start")) {
        return Stream.fromIterable([attachFrame(1, "exec-ok\n")]);
      }
      if (request.path.includes("/logs?")) {
        return Stream.fromIterable([attachFrame(1, "2026-05-17T12:00:00.000Z ready\n")]);
      }
      return Stream.empty;
    },
  };

  return { api, calls };
};

const appId = AppId.make("myapp");
const serviceName = ServiceName.make("web");

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const collectAsyncBytes = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  if (input !== undefined) for await (const chunk of input) chunks.push(chunk);
  return concatBytes(chunks);
};

const makeDataPlaneFakeApi = (options: { readonly failCopyTo?: boolean } = {}) => {
  const calls: PodmanHttpRequest[] = [];
  const containers = new Map<string, { readonly body: unknown; stdout: Uint8Array; exitCode: number }>();
  const volumes = new Map<string, Uint8Array>();
  const snapshots = new Map<string, Uint8Array>();
  const serviceFiles = new Map<string, Uint8Array>();
  const artifacts = new Map<string, Uint8Array>();
  let artifactCount = 0;
  let snapshotCount = 0;

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.promise(async (): Promise<PodmanHttpResponse> => {
        calls.push(request);
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          containers.set(name, { body: request.body, stdout: new Uint8Array(), exitCode: 0 });
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          const container = containers.get(name);
          const body = container?.body as
            | { Cmd?: ReadonlyArray<string>; Image?: string; HostConfig?: { Binds?: ReadonlyArray<string> } }
            | undefined;
          const volume = body?.HostConfig?.Binds?.[0]?.split(":")[0];
          const command = body?.Cmd?.join(" ");
          if (container !== undefined && volume !== undefined && command === "sh -c cat /data/payload")
            container.stdout = volumes.get(volume) ?? new Uint8Array();
          if (
            container !== undefined &&
            volume !== undefined &&
            command === "sh -c rm -rf /snapshot && mkdir -p /snapshot && cp -a /lando-data/. /snapshot/"
          )
            container.stdout = volumes.get(volume) ?? new Uint8Array();
          if (
            volume !== undefined &&
            body?.Image?.startsWith("localhost/lando-volume-snapshot:") === true &&
            command ===
              "sh -c find /lando-data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /snapshot/. /lando-data/"
          )
            volumes.set(volume, snapshots.get(body.Image) ?? new Uint8Array());
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/wait"))
          return { status: 200, body: JSON.stringify({ StatusCode: 0 }) };
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json"))
          return { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) };
        if (
          request.path.startsWith("/containers/") &&
          request.path.endsWith("?force=true") &&
          request.method === "DELETE"
        )
          return { status: 204, body: "" };
        if (request.path.startsWith("/commit?") && request.method === "POST") {
          snapshotCount += 1;
          const params = new URLSearchParams(request.path.slice(request.path.indexOf("?") + 1));
          const container = containers.get(params.get("container") ?? "");
          const body = container?.body as { HostConfig?: { Binds?: ReadonlyArray<string> } } | undefined;
          const volume = body?.HostConfig?.Binds?.[0]?.split(":")[0];
          const repo = params.get("repo") ?? "localhost/lando-volume-snapshot";
          const tag = params.get("tag") ?? `native-${snapshotCount}`;
          snapshots.set(`${repo}:${tag}`, volumes.get(volume ?? "") ?? new Uint8Array());
          return { status: 201, body: JSON.stringify({ id: `${repo}:${tag}` }) };
        }
        if (request.path === "/volumes" && request.method === "GET")
          return {
            status: 200,
            body: JSON.stringify({ Volumes: Array.from(volumes.keys()).map((Name) => ({ Name })) }),
          };
        if (request.path.startsWith("/volumes/") && request.method === "DELETE")
          return { status: 204, body: "" };
        if (
          request.path.startsWith("/containers/") &&
          request.path.includes("/archive?") &&
          request.method === "PUT"
        ) {
          if (options.failCopyTo === true)
            return { status: 500, body: JSON.stringify({ message: "forced copy failure" }) };
          const container = decodeURIComponent(
            request.path.slice("/containers/".length, request.path.indexOf("/archive?")),
          );
          const params = new URLSearchParams(request.path.slice(request.path.indexOf("?") + 1));
          serviceFiles.set(
            `${container}:${params.get("path") ?? ""}`,
            await collectAsyncBytes(request.stdin),
          );
          return { status: 200, body: "{}" };
        }
        if (request.path === "/images/load" && request.method === "POST") {
          artifactCount += 1;
          const ref = `imported:${artifactCount}`;
          artifacts.set(ref, await collectAsyncBytes(request.stdin));
          return { status: 200, body: JSON.stringify({ ref }) };
        }
        return {
          status: 500,
          body: JSON.stringify({ message: `unhandled ${request.method} ${request.path}` }),
        };
      }),
    stream: (request) => {
      calls.push(request);
      if (request.path.startsWith("/containers/") && request.path.includes("/logs?")) {
        const name = decodeURIComponent(
          request.path.slice("/containers/".length, request.path.indexOf("/logs?")),
        );
        return Stream.make(containers.get(name)?.stdout ?? new Uint8Array());
      }
      if (request.path.startsWith("/containers/") && request.path.includes("/attach?")) {
        const name = decodeURIComponent(
          request.path.slice("/containers/".length, request.path.indexOf("/attach?")),
        );
        return Stream.unwrap(
          Effect.promise(async () => {
            const container = containers.get(name);
            const body = container?.body as
              | { Cmd?: ReadonlyArray<string>; HostConfig?: { Binds?: ReadonlyArray<string> } }
              | undefined;
            const volume = body?.HostConfig?.Binds?.[0]?.split(":")[0];
            if (
              container !== undefined &&
              volume !== undefined &&
              body?.Cmd?.join(" ") === "sh -c cat > /data/payload"
            ) {
              volumes.set(volume, await collectAsyncBytes(request.stdin));
            }
            return Stream.empty;
          }),
        );
      }
      if (request.path.startsWith("/containers/") && request.path.includes("/archive?")) {
        const container = decodeURIComponent(
          request.path.slice("/containers/".length, request.path.indexOf("/archive?")),
        );
        const params = new URLSearchParams(request.path.slice(request.path.indexOf("?") + 1));
        const path = params.get("path") ?? "";
        const directory = path.slice(0, path.lastIndexOf("/")) || "/";
        return Stream.make(
          serviceFiles.get(`${container}:${path}`) ??
            serviceFiles.get(`${container}:${directory}`) ??
            new Uint8Array(),
        );
      }
      if (request.path.startsWith("/images/") && request.path.endsWith("/get")) {
        const ref = decodeURIComponent(request.path.slice("/images/".length, -"/get".length));
        return Stream.make(artifacts.get(ref) ?? new Uint8Array());
      }
      return Stream.empty;
    },
  };

  return { api, calls };
};

describe("provider-lando RuntimeProvider contract", () => {
  test("passes the SDK provider contract suite", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: fake.api }))),
    );

    await Effect.runPromise(runProviderContract(provider));
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
  });

  test("lists volumes through the Podman API", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: makeDataPlaneFakeApi().api }))),
    );

    const volumes = await Effect.runPromise(provider.listVolumes({ app: appId }));

    expect(volumes).toEqual([]);
  });

  test("runs the provider data-plane contract through the managed Podman API", async () => {
    const fake = makeDataPlaneFakeApi();
    await Effect.runPromise(
      runProviderDataPlaneContract({
        providerName: "lando",
        factory: () => RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: fake.api }))),
        observations: {
          usedNativeVolumeSnapshot: () =>
            fake.calls.some((call) => call.method === "POST" && call.path.startsWith("/commit?")),
          usedNativeServiceFileCopy: () =>
            fake.calls.some(
              (call) => call.path.startsWith("/containers/") && call.path.includes("/archive?"),
            ),
        },
      }),
    );
  });

  test("emits ServiceCopyError for copyToService failures", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: makeDataPlaneFakeApi({ failCopyTo: true }).api })),
      ),
    );
    const exit = await Effect.runPromiseExit(
      provider.copyToService(
        { app: appId, service: serviceName },
        {
          sourcePath: AbsolutePath.make(import.meta.path),
          targetPath: PortablePath.make("/tmp/payload"),
          overwrite: true,
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ServiceCopyError);
      expect(exit.cause.error._tag).toBe("ServiceCopyError");
      expect(exit.cause.error.providerId).toBe("lando");
    }
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "passes the SDK provider contract suite against a live Podman socket",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: makePodmanApiClient(socketPath ?? "") })),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("matrix: covers linux / darwin / win32 via fake Podman API", async () => {
    const buildProvider = (platform: "linux" | "darwin" | "win32") =>
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: makeFakeApi().api, platform })));

    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "@lando/provider-lando",
        cells: [
          { platform: "linux", supported: true, factory: () => buildProvider("linux") },
          { platform: "darwin", supported: true, factory: () => buildProvider("darwin") },
          { platform: "win32", supported: true, factory: () => buildProvider("win32") },
          { platform: "wsl", supported: false, skipReason: "provider-lando targets native Windows, not WSL" },
        ],
      }),
    );

    expect(report.providerName).toBe("@lando/provider-lando");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
      "wsl:skipped",
    ]);
  });
});
