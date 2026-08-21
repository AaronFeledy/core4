import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { makePluginStateStore } from "@lando/core/testing";
import type { PodmanHttpRequest, PodmanHttpResponse } from "@lando/provider-lando";
import { type PodmanApiClient, makePodmanApiClient, makeProviderLayer } from "@lando/provider-podman";
import { ServiceCopyError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type PlanMetadata,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import {
  runProviderContract,
  runProviderContractMatrix,
  runProviderDataPlaneContract,
} from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";

const providerId = ProviderId.make("podman");
const appId = AppId.make("persisted-podman");
const serviceName = ServiceName.make("web");
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

const metadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-27T00:00:00Z"),
  source: "provider-podman contract test",
  runtime: 4,
};

const servicePlan: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Persisted Podman",
  slug: "persisted-podman",
  root: AbsolutePath.make("/tmp/lando-provider-podman-persisted"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const tarBlockSize = 512;

const padToBlock = (size: number): number => Math.ceil(size / tarBlockSize) * tarBlockSize;

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number) => {
  target.set(new TextEncoder().encode(value).slice(0, length), offset);
};

const octal = (value: number, width: number): string | undefined => {
  const text = value.toString(8);
  if (text.length > width - 1) return undefined;
  return text.padStart(width - 1, "0");
};

const archiveFile = (name: string, payload: Uint8Array): Uint8Array | undefined => {
  if (name.length === 0 || new TextEncoder().encode(name).byteLength > 100) return undefined;
  const mode = octal(0o644, 8);
  const uid = octal(0, 8);
  const gid = octal(0, 8);
  const size = octal(payload.byteLength, 12);
  const mtime = octal(0, 12);
  if (
    mode === undefined ||
    uid === undefined ||
    gid === undefined ||
    size === undefined ||
    mtime === undefined
  ) {
    return undefined;
  }
  const header = new Uint8Array(tarBlockSize);
  writeAscii(header, 0, name, 100);
  writeAscii(header, 100, `${mode}\0`, 8);
  writeAscii(header, 108, `${uid}\0`, 8);
  writeAscii(header, 116, `${gid}\0`, 8);
  writeAscii(header, 124, `${size}\0`, 12);
  writeAscii(header, 136, `${mtime}\0`, 12);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, "ustar", 6);
  writeAscii(header, 263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumOctal = octal(checksum, 7);
  if (checksumOctal === undefined) return undefined;
  writeAscii(header, 148, `${checksumOctal}\0 `, 8);
  const output = new Uint8Array(tarBlockSize + padToBlock(payload.byteLength) + tarBlockSize * 2);
  output.set(header, 0);
  output.set(payload, tarBlockSize);
  return output;
};

const createBodyBinds = (body: unknown): ReadonlyArray<string> => {
  const parsed =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return undefined;
          }
        })()
      : body;
  if (typeof parsed !== "object" || parsed === null) return [];
  const hostConfig = Reflect.get(parsed, "HostConfig");
  if (typeof hostConfig !== "object" || hostConfig === null) return [];
  const binds = Reflect.get(hostConfig, "Binds");
  return Array.isArray(binds) ? binds.filter((bind): bind is string => typeof bind === "string") : [];
};

const archiveForBindTarget = (binds: ReadonlyArray<string>, archivePath: string): Uint8Array | undefined => {
  for (const bind of binds) {
    const withoutOptions = bind.endsWith(":ro") || bind.endsWith(":rw") ? bind.slice(0, -3) : bind;
    const separator = withoutOptions.lastIndexOf(":");
    if (separator < 0) continue;
    const host = withoutOptions.slice(0, separator);
    const target = withoutOptions.slice(separator + 1);
    if (target !== archivePath) continue;
    try {
      const payload = readFileSync(host);
      const name = target.slice(target.lastIndexOf("/") + 1) || target;
      return archiveFile(name, payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const execs = new Map<string, number>();
  const containerBinds = new Map<string, ReadonlyArray<string>>();
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
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
        if (request.path.startsWith("/containers/create")) {
          const name = new URLSearchParams(request.path.slice(request.path.indexOf("?") + 1)).get("name");
          if (name !== null && name.length > 0) {
            existing.add(name);
            containerBinds.set(name, createBodyBinds(request.body));
            return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
          }
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
        if (request.path.startsWith("/libpod/containers/") && request.path.endsWith("/wait")) {
          return { status: 200, body: "0" };
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
      if (request.path.startsWith("/containers/") && request.path.includes("/archive?")) {
        const name = decodeURIComponent(
          request.path.slice("/containers/".length, request.path.indexOf("/archive?")),
        );
        const params = new URLSearchParams(request.path.slice(request.path.indexOf("?") + 1));
        const archive = archiveForBindTarget(containerBinds.get(name) ?? [], params.get("path") ?? "");
        if (archive !== undefined) return Stream.make(archive);
      }
      return Stream.empty;
    },
  };

  return { api, calls };
};

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

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
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
            | { Cmd?: ReadonlyArray<string>; HostConfig?: { Binds?: ReadonlyArray<string> } }
            | undefined;
          const binds = body?.HostConfig?.Binds ?? [];
          const volume = binds[0]?.split(":")[0];
          const snapshotVolume = binds[1]?.split(":")[0];
          const command = body?.Cmd?.join(" ");
          if (container !== undefined && volume !== undefined && command === "sh -c cat /data/payload")
            container.stdout = volumes.get(volume) ?? new Uint8Array();
          if (container !== undefined && volume !== undefined && command === "tar -C /lando-data -cf - .")
            container.stdout = volumes.get(volume) ?? new Uint8Array();
          const snapshotWrite = command?.match(/tar -C \/lando-data -cf \/lando-snapshots\/([^ ]+) \./u)?.[1];
          if (
            container !== undefined &&
            volume !== undefined &&
            snapshotVolume !== undefined &&
            snapshotWrite !== undefined
          )
            snapshots.set(`${snapshotVolume}/${snapshotWrite}`, volumes.get(volume) ?? new Uint8Array());
          const snapshotRead = command?.match(/tar -C \/lando-data -xf \/lando-snapshots\/([^ ]+)/u)?.[1];
          if (
            container !== undefined &&
            volume !== undefined &&
            snapshotVolume !== undefined &&
            snapshotRead !== undefined
          ) {
            const snapshot = snapshots.get(`${snapshotVolume}/${snapshotRead}`);
            if (snapshot === undefined) container.exitCode = 1;
            else volumes.set(volume, snapshot);
          }
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/wait"))
          return { status: 200, body: JSON.stringify({ StatusCode: 0 }) };
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          return {
            status: 200,
            body: JSON.stringify({ State: { ExitCode: containers.get(name)?.exitCode ?? 0 } }),
          };
        }
        if (
          request.path.startsWith("/containers/") &&
          request.path.endsWith("?force=true") &&
          request.method === "DELETE"
        )
          return { status: 204, body: "" };
        if (request.path.startsWith("/volumes/snapshots/") && request.method === "POST") {
          const id = decodeURIComponent(request.path.slice("/volumes/snapshots/".length));
          snapshots.set(id, await collectAsyncBytes(request.stdin));
          return { status: 201, body: "{}" };
        }
        if (
          request.path.startsWith("/volumes/") &&
          request.path.includes("/archive?") &&
          request.method === "POST"
        ) {
          const name = decodeURIComponent(
            request.path.slice("/volumes/".length, request.path.indexOf("/archive?")),
          );
          volumes.set(name, await collectAsyncBytes(request.stdin));
          return { status: 200, body: "{}" };
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
            if (
              container !== undefined &&
              volume !== undefined &&
              body?.Cmd?.join(" ") === "tar -C /lando-data -xf -"
            ) {
              volumes.set(volume, await collectAsyncBytes(request.stdin));
            }
            return Stream.empty;
          }),
        );
      }
      if (request.path.startsWith("/volumes/") && request.path.endsWith("/archive")) {
        const name = decodeURIComponent(request.path.slice("/volumes/".length, -"/archive".length));
        return Stream.make(volumes.get(name) ?? new Uint8Array());
      }
      if (request.path.startsWith("/volumes/snapshots/"))
        return Stream.make(
          snapshots.get(decodeURIComponent(request.path.slice("/volumes/snapshots/".length))) ??
            new Uint8Array(),
        );
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

interface FakePodmanApiHooks {
  readonly failStartFor?: ReadonlySet<string>;
}

const makeFakeApiWithHooks = (hooks: FakePodmanApiHooks = {}) => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);
        if (request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const createdName = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          if (hooks.failStartFor?.has(name) === true) {
            return { status: 500, body: `forced start failure for ${name}` };
          }
          if (running.has(name)) {
            return { status: 304, body: "" };
          }
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length));
          running.delete(name);
          return { status: 204, body: "" };
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
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (request) => {
      calls.push(request);
      return Stream.empty;
    },
  };

  return { api, calls, running, existing };
};

const dbServiceName = ServiceName.make("db");

const dbServicePlan: ServicePlan = {
  name: dbServiceName,
  type: "postgres",
  provider: providerId,
  primary: false,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const multiServicePlan: AppPlan = {
  id: appId,
  name: "Persisted Podman",
  slug: "persisted-podman",
  root: AbsolutePath.make("/tmp/lando-provider-podman-persisted"),
  provider: providerId,
  services: { [dbServiceName]: dbServicePlan, [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("provider-podman RuntimeProvider contract", () => {
  test("passes the SDK provider contract suite", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );

    expect(provider.id).toBe("podman");
    expect(provider.capabilities.bindMountPerformance).toBe("native");

    await Effect.runPromise(runProviderContract(provider));
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
  });

  test("lists volumes through the Podman API", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ podmanApi: makeDataPlaneFakeApi().api, platform: "linux", env: {} }),
        ),
      ),
    );

    const volumes = await Effect.runPromise(provider.listVolumes({ app: appId }));

    expect(volumes).toEqual([]);
  });

  test("runs the provider data-plane contract through the Podman API", async () => {
    const fake = makeDataPlaneFakeApi();
    await Effect.runPromise(
      runProviderDataPlaneContract({
        providerName: "podman",
        factory: () =>
          RuntimeProvider.pipe(
            Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
          ),
        observations: {
          usedCopyVolumeSnapshot: () =>
            fake.calls.some(
              (call) =>
                call.path.startsWith("/containers/create?name=") &&
                ((call.body as { Cmd?: ReadonlyArray<string> } | undefined)?.Cmd?.join(" ") ?? "").startsWith(
                  "sh -c mkdir -p /lando-snapshots && tar -C /lando-data -cf /lando-snapshots/",
                ),
            ),
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
        Effect.provide(
          makeProviderLayer({
            podmanApi: makeDataPlaneFakeApi({ failCopyTo: true }).api,
            platform: "linux",
            env: {},
          }),
        ),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.copyToService(
          { app: appId, service: serviceName },
          {
            sourcePath: AbsolutePath.make(import.meta.path),
            targetPath: PortablePath.make("/tmp/payload"),
            overwrite: true,
          },
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ServiceCopyError);
      expect(exit.cause.error._tag).toBe("ServiceCopyError");
      expect(exit.cause.error.providerId).toBe("podman");
    }
  });

  test("reports the Podman provider when an invalid compose knob fails apply", async () => {
    // Given
    const fake = makeFakeApiWithHooks({});
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );
    const invalidKnobPlan: AppPlan = {
      ...plan,
      services: {
        [serviceName]: { ...servicePlan, extensions: { compose: { cap_add: 42 } } },
      },
    };

    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(invalidKnobPlan, { reconcile: true })),
    );

    // Then
    const failures = Exit.isFailure(exit) ? Array.from(Cause.failures(exit.cause)) : [];
    expect(failures).toContainEqual(
      expect.objectContaining({
        _tag: "ServiceStartError",
        operation: "bringUp.knobs",
        providerId,
      }),
    );
  });

  test("persists applied plans for follow-up CLI invocations", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-state-"));
    try {
      const firstFake = makeFakeApi();
      const firstState = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const firstProvider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: firstFake.api,
              platform: "linux",
              env: {},
              stateDir,
              appliedPlanState: firstState,
            }),
          ),
        ),
      );
      await Effect.runPromise(Effect.scoped(firstProvider.apply(plan, { reconcile: true })));

      const secondFake = makeFakeApi();
      const secondState = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const secondProvider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: secondFake.api,
              platform: "linux",
              env: {},
              stateDir,
              appliedPlanState: secondState,
            }),
          ),
        ),
      );
      const snapshot = await Effect.runPromise(secondProvider.inspect({ app: appId, service: serviceName }));
      const listed = await Effect.runPromise(secondProvider.list({}));

      expect(snapshot.providerId).toBe(providerId);
      expect(listed.map((entry) => entry.app)).toEqual([appId]);
      expect(secondFake.calls.some((call) => call.path.endsWith("/json"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "passes the SDK provider contract suite against a live Podman socket",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: makePodmanApiClient(socketPath ?? ""),
              platform: "linux",
            }),
          ),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("matrix: covers every host identity via fake Podman API", async () => {
    const buildProvider = (platform: "linux" | "darwin" | "win32" | "wsl") =>
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: makeFakeApi().api,
            platform,
            env: {},
          }),
        ),
      );

    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "@lando/provider-podman",
        cells: [
          { platform: "linux", supported: true, factory: () => buildProvider("linux") },
          { platform: "darwin", supported: true, factory: () => buildProvider("darwin") },
          { platform: "win32", supported: true, factory: () => buildProvider("win32") },
          { platform: "wsl", supported: true, factory: () => buildProvider("wsl") },
        ],
      }),
    );

    expect(report.providerName).toBe("@lando/provider-podman");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
      "wsl:passed",
    ]);
  });

  test("rolls back containers and network when a service start fails", async () => {
    const fake = makeFakeApiWithHooks({ failStartFor: new Set(["lando-persisted-podman-web"]) });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(multiServicePlan, { reconcile: true })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBe(0);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      true,
    );
  });

  test("cleans up already-started services when abort signal is observed", async () => {
    const inner = makeFakeApiWithHooks({});
    const controller = new AbortController();
    let startCallCount = 0;
    const wrappedApi: PodmanApiClient = {
      info: inner.api.info,
      ping: inner.api.ping,
      request: (req) => {
        const request = inner.api.request;
        if (request === undefined) {
          throw new Error("expected request handler");
        }
        if (req.path.endsWith("/start")) {
          startCallCount++;
          const result = request(req);
          if (startCallCount === 1) {
            return result.pipe(Effect.tap(() => Effect.sync(() => controller.abort())));
          }
          return result;
        }
        return request(req);
      },
      ...(inner.api.stream === undefined ? {} : { stream: inner.api.stream }),
    };

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: wrappedApi, platform: "linux", env: {} })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(multiServicePlan, { reconcile: true, signal: controller.signal })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(inner.running.size).toBe(0);
    expect(inner.calls.some((call) => call.path.includes("/stop"))).toBe(true);
  });
});
