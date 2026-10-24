import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit, Option, Schema, Stream } from "effect";

import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { type PodmanApiClient, makePodmanApiClient, layer as providerLayer } from "@lando/provider-podman";
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
  runProviderStartRetentionContract,
  runProviderVolumeCreationContract,
} from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const makeProviderLayer = (options: NonNullable<Parameters<typeof providerLayer>[0]> = {}) =>
  providerLayer({
    ...options,
    appliedPlanState:
      options.appliedPlanState ??
      makePluginStateStore(
        makeTestStateStore().service,
        AbsolutePath.make(join(tmpdir(), `podman-contract-${crypto.randomUUID()}`)),
        ownerOnlyFileAccess,
      ),
  });

const providerId = ProviderId.make("podman");
const appId = AppId.make("persisted-podman");
const serviceName = ServiceName.make("web");
const textEncoder = new TextEncoder();

const attachBytesFrame = (stream: 1 | 2, payload: Uint8Array) => {
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = stream;
  frame[4] = (payload.length >>> 24) & 0xff;
  frame[5] = (payload.length >>> 16) & 0xff;
  frame[6] = (payload.length >>> 8) & 0xff;
  frame[7] = payload.length & 0xff;
  frame.set(payload, 8);
  return frame;
};
const attachFrame = (stream: 1 | 2, text: string) => attachBytesFrame(stream, textEncoder.encode(text));

const metadata: PlanMetadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-27T00:00:00Z"),
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
  valueModel: 1,
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
  const networks = new Map<string, object>();
  const configs = new Map<string, unknown>();
  const createdVolumes = new Map<string, unknown>();
  const running = new Set<string>();
  const existing = new Set<string>();
  const execs = new Map<string, number>();
  const containerBinds = new Map<string, ReadonlyArray<string>>();
  const calls: EngineHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);

        if (request.path.startsWith("/libpod/volumes/prune?")) return { status: 200, body: "{}" };
        if (request.path === "/volumes/create") {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({ Name: Schema.String, Labels: Schema.Record(Schema.String, Schema.String) }),
          )(request.body);
          if (createdVolumes.has(body.Name)) return { status: 409, body: "{}" };
          createdVolumes.set(body.Name, body);
          return { status: 201, body: JSON.stringify(body) };
        }

        if (request.path.startsWith("/volumes/")) {
          const name = decodeURIComponent(request.path.slice("/volumes/".length).split("?")[0] ?? "");
          if (request.method === "DELETE")
            return { status: createdVolumes.delete(name) ? 204 : 404, body: "" };
          const volume = createdVolumes.get(name);
          return { status: volume === undefined ? 404 : 200, body: JSON.stringify(volume ?? {}) };
        }

        if (request.path === "/networks/create") {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              Name: Schema.String,
              Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            }),
          )(request.body);
          networks.set(body.Name, { Id: body.Name, ...body });
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          const observed = networks.get(decodeURIComponent(request.path.slice("/networks/".length)));
          return { status: observed === undefined ? 404 : 200, body: JSON.stringify(observed ?? {}) };
        }
        if (request.path.startsWith("/networks/") && request.method === "DELETE") {
          networks.delete(decodeURIComponent(request.path.slice("/networks/".length)));
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
            configs.set(name, request.body);
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
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length)).replace(
            /-id$/u,
            "",
          );
          const wasRunning = running.delete(name);
          return { status: wasRunning ? 204 : 304, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = decodeURIComponent(
            request.path.slice("/containers/".length, -"?force=true".length),
          ).replace(/-id$/u, "");
          const existed = existing.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          return {
            status: 200,
            body: JSON.stringify({
              Os: "linux",
              Architecture: "amd64",
              RepoDigests: ["img@sha256:test"],
            }),
          };
        }
        if (request.path.endsWith("/json")) {
          const key = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          const name = existing.has(key) ? key : key.replace(/-id$/u, "");
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              Config: configs.get(name),
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "stopped" },
            }),
          };
        }

        if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
          return {
            status: 200,
            body: JSON.stringify(
              Array.from(existing).map((name) => ({
                Id: `${name}-id`,
                State: running.has(name) ? "running" : "exited",
                Labels: Schema.decodeUnknownSync(
                  Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
                )(configs.get(name)).Labels,
              })),
            ),
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
        return Stream.fromIterable([
          attachFrame(1, "2026-05-17T12:00:00.000Z ready\n"),
          attachFrame(1, "2026-05-17T12:00:00.000Z lando-contract-split-"),
          attachFrame(1, "2026-05-17T12:00:00.000Z line\n"),
          attachFrame(1, `2026-05-17T12:00:00.000Z ${"L".repeat(16_384)}`),
          attachFrame(1, `2026-05-17T12:00:00.000Z ${"L".repeat(3_616)}\n`),
        ]);
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
  const calls: EngineHttpRequest[] = [];
  const containers = new Map<string, { readonly body: unknown; stdout: Uint8Array; exitCode: number }>();
  const volumes = new Map<string, Uint8Array>();
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>();
  const snapshots = new Map<string, Uint8Array>();
  const serviceFiles = new Map<string, Uint8Array>();
  const artifacts = new Map<string, Uint8Array>();
  let artifactCount = 0;

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.promise(async (): Promise<EngineHttpResponse> => {
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
          const snapshotFile = body?.Cmd?.[2]?.match(/file=\/lando-snapshots\/([^;]+)/u)?.[1];
          if (
            container !== undefined &&
            volume !== undefined &&
            snapshotVolume !== undefined &&
            snapshotFile
          ) {
            const payload = volumes.get(volume) ?? new Uint8Array();
            snapshots.set(`${snapshotVolume}/${snapshotFile}`, payload);
            container.stdout = textEncoder.encode(`fake-digest ${payload.byteLength}\n`);
          }
          const restoreFile = body?.Cmd?.[3] === "lando-restore" ? body.Cmd[4]?.split("/").at(-1) : undefined;
          if (volume !== undefined && snapshotVolume !== undefined && restoreFile !== undefined) {
            const snapshot = snapshots.get(`${snapshotVolume}/${restoreFile}`);
            if (snapshot === undefined && container !== undefined) container.exitCode = 1;
            else if (snapshot !== undefined) volumes.set(volume, snapshot);
          }
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
        if (request.path === "/volumes/create" && request.method === "POST") {
          const body = request.body as {
            readonly Name?: string;
            readonly Labels?: Readonly<Record<string, string>>;
          };
          const name = body.Name ?? "";
          if (volumes.has(name)) return { status: 409, body: "{}" };
          const labels = body.Labels ?? {};
          volumes.set(name, new Uint8Array());
          volumeLabels.set(name, labels);
          return { status: 201, body: JSON.stringify({ Name: name, Labels: labels }) };
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
            body: JSON.stringify({
              Volumes: Array.from(volumes.keys()).map((Name) => ({
                Name,
                Labels: volumeLabels.get(Name) ?? {},
              })),
            }),
          };
        if (request.path.startsWith("/volumes/") && request.method === "GET") {
          const name = decodeURIComponent(request.path.slice("/volumes/".length));
          return volumes.has(name)
            ? {
                status: 200,
                body: JSON.stringify({
                  Name: name,
                  Driver: "local",
                  Options: {},
                  Labels: volumeLabels.get(name) ?? {},
                }),
              }
            : { status: 404, body: "{}" };
        }
        if (request.path.startsWith("/volumes/") && request.method === "DELETE") {
          const name = decodeURIComponent(request.path.slice("/volumes/".length));
          volumes.delete(name);
          volumeLabels.delete(name);
          return { status: 204, body: "" };
        }
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
        return Stream.make(attachBytesFrame(1, containers.get(name)?.stdout ?? new Uint8Array()));
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
  const networks = new Map<string, object>();
  const configs = new Map<string, unknown>();
  const running = new Set<string>();
  const existing = new Set<string>();
  const containerIds = new Map<string, string>();
  const idToName = new Map<string, string>();
  let createGeneration = 0;
  const volumes = new Set<string>();
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>();
  const calls: EngineHttpRequest[] = [];
  const failStartFor = new Set<string>(hooks.failStartFor ?? []);
  let abortAfterStarts = 0;
  let abortController: AbortController | undefined;
  let successfulStarts = 0;

  const resolveContainerName = (key: string): string => {
    if (existing.has(key)) return key;
    return idToName.get(key) ?? key;
  };

  const retentionHooks = {
    setFailStartFor: (containerNames: ReadonlyArray<string>) => {
      failStartFor.clear();
      for (const name of containerNames) failStartFor.add(name);
    },
    setAbortAfterStarts: (count: number, controller?: AbortController) => {
      abortAfterStarts = count;
      abortController = controller;
      successfulStarts = 0;
    },
    hasNetwork: (networkName: string) => networks.has(networkName),
    hasVolume: (volumeName: string) => volumes.has(volumeName),
  };

  const api: PodmanApiClient = {
    info: Effect.succeed({ version: { Version: "6.0.2" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        if (request.path.startsWith("/libpod/volumes/prune")) {
          // Ownership-complete prune: drop every tracked volume (tests only own this fake).
          volumes.clear();
          volumeLabels.clear();
          return { status: 200, body: "[]" };
        }
        if (request.path === "/networks/create") {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              Name: Schema.String,
              Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            }),
          )(request.body);
          networks.set(body.Name, { Id: body.Name, ...body });
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          const observed = networks.get(decodeURIComponent(request.path.slice("/networks/".length)));
          return { status: observed === undefined ? 404 : 200, body: JSON.stringify(observed ?? {}) };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          networks.delete(decodeURIComponent(request.path.slice("/networks/".length)));
          return { status: 204, body: "" };
        }
        if (request.path === "/volumes/create") {
          const requested = Schema.decodeUnknownSync(
            Schema.Struct({ Name: Schema.String, Labels: Schema.Record(Schema.String, Schema.String) }),
          )(request.body);
          const requestedName = requested.Name;
          const existed = volumes.has(requestedName);
          volumes.add(requestedName);
          if (!existed) volumeLabels.set(requestedName, requested.Labels);
          return { status: existed ? 409 : 201, body: JSON.stringify(requested) };
        }
        if (request.method === "GET" && request.path.startsWith("/volumes/")) {
          const volName = decodeURIComponent(request.path.slice("/volumes/".length));
          return volumes.has(volName)
            ? {
                status: 200,
                body: JSON.stringify({ Name: volName, Labels: volumeLabels.get(volName) ?? {} }),
              }
            : { status: 404, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/volumes/")) {
          const volName = decodeURIComponent(request.path.slice("/volumes/".length));
          const deleted = volumes.delete(volName);
          volumeLabels.delete(volName);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const createdName = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          createGeneration += 1;
          const id = `${createdName}-g${createGeneration}`;
          existing.add(createdName);
          configs.set(createdName, request.body);
          containerIds.set(createdName, id);
          idToName.set(id, createdName);
          return { status: 201, body: JSON.stringify({ Id: id }) };
        }
        if (request.path.endsWith("/start")) {
          const name = resolveContainerName(
            decodeURIComponent(request.path.slice("/containers/".length, -"/start".length)),
          );
          if (failStartFor.has(name)) {
            return { status: 500, body: `forced start failure for ${name}` };
          }
          if (running.has(name)) {
            return { status: 304, body: "" };
          }
          running.add(name);
          successfulStarts += 1;
          if (abortAfterStarts > 0 && successfulStarts >= abortAfterStarts && abortController !== undefined) {
            abortController.abort();
          }
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = resolveContainerName(
            decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length)),
          );
          running.delete(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = resolveContainerName(
            decodeURIComponent(request.path.slice("/containers/".length, -"?force=true".length)),
          );
          const id = containerIds.get(name);
          const existed = existing.delete(name);
          running.delete(name);
          containerIds.delete(name);
          if (id !== undefined) idToName.delete(id);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          return {
            status: 200,
            body: JSON.stringify({
              Os: "linux",
              Architecture: "amd64",
              RepoDigests: ["img@sha256:test"],
            }),
          };
        }
        if (request.path.endsWith("/json")) {
          const name = resolveContainerName(
            decodeURIComponent(request.path.slice("/containers/".length, -"/json".length)),
          );
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: containerIds.get(name) ?? `${name}-id`,
              Config: configs.get(name),
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

  return { api, calls, running, existing, volumes, containerIds, retentionHooks };
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
  valueModel: 1,
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
    await Effect.runPromise(
      runProviderVolumeCreationContract(
        provider,
        () =>
          fake.calls.filter(
            (call) => call.method === "POST" && /\/containers\/[^/]+\/start$/u.test(call.path),
          ).length,
      ),
    );
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
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(ServiceCopyError);
      if (error instanceof ServiceCopyError) {
        expect(error._tag).toBe("ServiceCopyError");
        expect(error.providerId).toBe("podman");
      }
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
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
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
      const firstState = makePluginStateStore(
        makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
        AbsolutePath.make(stateDir),
        ownerOnlyFileAccess,
      );
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
      const secondState = makePluginStateStore(
        makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
        AbsolutePath.make(stateDir),
        ownerOnlyFileAccess,
      );
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
  }, 30_000);

  test("destroy and logs honor a caller-supplied plan when no plan is persisted", async () => {
    const fake = makeFakeApi();
    if (fake.api.request === undefined) throw new TypeError("Fake request is missing");
    await Effect.runPromise(
      fake.api.request({
        method: "POST",
        path: `/containers/create?name=lando-${plan.slug}-${serviceName}`,
        body: {
          Labels: {
            "dev.lando.app": plan.id,
            "dev.lando.app-root": plan.root,
            "dev.lando.service": serviceName,
          },
        },
      }),
    );
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );
    const containerName = `lando-${plan.slug}-${serviceName}`;

    const chunks = await Effect.runPromise(
      Stream.runCollect(provider.logs({ app: appId, service: serviceName, plan }, { follow: false })),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(fake.calls.some((call) => call.path.includes(`/containers/${containerName}/logs?`))).toBe(true);

    await Effect.runPromise(provider.destroy({ app: appId, plan }, { volumes: false }));
    expect(
      fake.calls.some(
        (call) => call.method === "DELETE" && call.path === `/containers/${containerName}-id?force=true`,
      ),
    ).toBe(true);
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

  test("retains containers and network when a service start fails", async () => {
    const fake = makeFakeApiWithHooks({ failStartFor: new Set(["lando-persisted-podman-web"]) });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(multiServicePlan, { reconcile: false })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.has("lando-persisted-podman-db")).toBe(true);
    expect(fake.existing.has("lando-persisted-podman-web")).toBe(true);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      false,
    );
  });

  test("retains already-started services when abort signal is observed", async () => {
    const fake = makeFakeApiWithHooks({});
    const controller = new AbortController();
    fake.retentionHooks.setAbortAfterStarts(1, controller);
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(multiServicePlan, { reconcile: false, signal: controller.signal })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBeGreaterThan(0);
    expect(
      fake.calls.some((call) => call.method === "DELETE" && call.path.includes("lando-persisted-podman-")),
    ).toBe(false);
  });

  test("runs the provider start-retention contract through the Podman API", async () => {
    const fake = makeFakeApiWithHooks({});
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );
    await Effect.runPromise(runProviderStartRetentionContract(provider, fake.retentionHooks));
  });
});
