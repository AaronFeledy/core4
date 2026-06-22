import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";

import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract, runProviderContractMatrix } from "@lando/sdk/test";
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

  test("fails closed for unsupported volume listing", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: makeFakeApi().api }))),
    );

    const exit = await Effect.runPromiseExit(provider.listVolumes({ app: "myapp" as never }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(exit.cause.toString()).toContain("ProviderUnavailableError");
    expect(exit.cause.toString()).toContain("listVolumes");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "passes the SDK provider contract suite against a live Podman socket",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
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
