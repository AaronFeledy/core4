import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stripHostProxyRunLando } from "@lando/core/testing";
import { Cause, Effect, Exit, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import { ProviderUnavailableError, ServiceCopyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ServiceName } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import {
  runProviderContract,
  runProviderContractMatrix,
  runProviderDataPlaneContract,
} from "@lando/sdk/test";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";
import { IntelMacUnsupportedError } from "../src/host-support.ts";

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
    info: Effect.succeed({}),
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
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: fake.api,
          }),
        ),
      ),
    );

    await Effect.runPromise(runProviderContract(provider));
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
  });

  test("lists volumes through the Podman API", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: makeDataPlaneFakeApi().api,
          }),
        ),
      ),
    );

    const volumes = await Effect.runPromise(provider.listVolumes({ app: appId }));

    expect(volumes).toEqual([]);
  });

  test("runs the provider data-plane contract through the managed Podman API", async () => {
    const fake = makeDataPlaneFakeApi();
    await Effect.runPromise(
      runProviderDataPlaneContract({
        providerName: "lando",
        factory: () =>
          RuntimeProvider.pipe(
            Effect.provide(
              makeProviderLayer({
                sanitizeAppliedPlan: stripHostProxyRunLando,
                platform: "linux",
                podmanApi: fake.api,
              }),
            ),
          ),
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
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: makeDataPlaneFakeApi({ failCopyTo: true }).api,
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
          Effect.provide(
            makeProviderLayer({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform: "linux",
              podmanApi: makePodmanApiClient(socketPath ?? ""),
            }),
          ),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("matrix: covers every host identity via fake Podman API", async () => {
    const buildProvider = (platform: "linux" | "darwin" | "win32" | "wsl", arch?: string) =>
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            podmanApi: makeFakeApi().api,
            platform,
            ...(arch === undefined ? {} : { arch }),
          }),
        ),
      );

    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "@lando/provider-lando",
        cells: [
          { platform: "linux", supported: true, factory: () => buildProvider("linux") },
          { platform: "darwin", supported: true, factory: () => buildProvider("darwin", "arm64") },
          { platform: "win32", supported: true, factory: () => buildProvider("win32") },
          { platform: "wsl", supported: true, factory: () => buildProvider("wsl") },
        ],
      }),
    );

    expect(report.providerName).toBe("@lando/provider-lando");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
      "wsl:passed",
    ]);
  });

  test("matrix: darwin/x64 fail-closes getStatus and setup while remaining available", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            podmanApi: makeFakeApi().api,
            platform: "darwin",
            arch: "x64",
          }),
        ),
      ),
    );

    expect(await Effect.runPromise(provider.isAvailable)).toBe(true);

    const statusExit = await Effect.runPromiseExit(provider.getStatus);
    expect(Exit.isFailure(statusExit)).toBe(true);
    if (Exit.isFailure(statusExit)) {
      const failure = Cause.failureOption(statusExit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(IntelMacUnsupportedError);
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        if (failure.value instanceof ProviderUnavailableError) {
          expect(failure.value.remediation).toContain("lando setup --provider=docker");
        }
      }
    }

    const plan = await Effect.runPromise(provider.planSetup({ force: false }));
    const setupExit = await Effect.runPromiseExit(provider.setup(plan, { force: false }).pipe(Effect.scoped));
    expect(Exit.isFailure(setupExit)).toBe(true);
    if (Exit.isFailure(setupExit)) {
      const failure = Cause.failureOption(setupExit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(IntelMacUnsupportedError);
      }
    }
  });
});
