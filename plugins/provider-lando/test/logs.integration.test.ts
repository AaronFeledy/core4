import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, logs, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("logsapp");
const appRoot = AbsolutePath.make("/tmp/lando-logs-app");
const textEncoder = new TextEncoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "logs.integration.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('lando logs ready'); setInterval(() => {}, 1000)"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
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
  name: "Logs App",
  slug: "logsapp",
  root: appRoot,
  provider: providerId,
  services: { [node.name]: node },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const frame = (stream: "stdout" | "stderr", text: string): Uint8Array => {
  const payload = textEncoder.encode(text);
  const output = new Uint8Array(8 + payload.length);
  output[0] = stream === "stdout" ? 1 : 2;
  output[4] = (payload.length >>> 24) & 0xff;
  output[5] = (payload.length >>> 16) & 0xff;
  output[6] = (payload.length >>> 8) & 0xff;
  output[7] = payload.length & 0xff;
  output.set(payload, 8);
  return output;
};

const makeFakeApi = (...chunks: ReadonlyArray<Uint8Array>) => {
  const calls: PodmanHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    stream: (request) => {
      calls.push(request);
      return Stream.fromIterable(chunks);
    },
  };

  return { api, calls };
};

const collectLines = (chunks: Iterable<LogChunk>) => Array.from(chunks, (chunk) => chunk.line);

describe("provider-lando logs", () => {
  test("returns historical logs as a finite stream", async () => {
    const fake = makeFakeApi(frame("stdout", "2026-05-14T00:00:00Z lando logs ready\n"));

    const chunks = await Effect.runPromise(
      logs(plan, { app: appId, service: node.name }, { follow: false }, { podmanApi: fake.api }).pipe(
        Stream.runCollect,
      ),
    );

    expect(collectLines(chunks)).toContain("lando logs ready");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("GET");
    expect(fake.calls[0]?.path).toContain("/containers/lando-logsapp-node/logs?");
    expect(fake.calls[0]?.path).toContain("follow=false");
  });

  test("decodes raw Podman log bytes", async () => {
    const fake = makeFakeApi(textEncoder.encode("2026-05-14T00:00:00Z raw podman ready\n"));

    const chunks = await Effect.runPromise(
      logs(plan, { app: appId, service: node.name }, { follow: false }, { podmanApi: fake.api }).pipe(
        Stream.runCollect,
      ),
    );

    expect(Array.from(chunks, (chunk) => [chunk.service, chunk.stream, chunk.line])).toEqual([
      [node.name, "stdout", "raw podman ready"],
    ]);
  });

  test("does not lock into framed mode after an empty chunk", async () => {
    const fake = makeFakeApi(
      new Uint8Array(0),
      textEncoder.encode("2026-05-14T00:00:00Z raw podman after empty chunk\n"),
    );

    const chunks = await Effect.runPromise(
      logs(plan, { app: appId, service: node.name }, { follow: false }, { podmanApi: fake.api }).pipe(
        Stream.runCollect,
      ),
    );

    expect(Array.from(chunks, (chunk) => [chunk.service, chunk.stream, chunk.line])).toEqual([
      [node.name, "stdout", "raw podman after empty chunk"],
    ]);
  });

  test("follow defaults to true and streams new chunks", async () => {
    const fake = makeFakeApi(frame("stdout", "first\n"), frame("stderr", "second\n"));

    const chunks = await Effect.runPromise(
      logs(plan, { app: appId, service: node.name }, {}, { podmanApi: fake.api }).pipe(Stream.runCollect),
    );

    expect(Array.from(chunks, (chunk) => [chunk.stream, chunk.line])).toEqual([
      ["stdout", "first"],
      ["stderr", "second"],
    ]);
    expect(fake.calls[0]?.path).toContain("follow=true");
  });

  test("forwards the since cursor to the Podman logs query", async () => {
    const fake = makeFakeApi(frame("stdout", "windowed\n"));

    await Effect.runPromise(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, since: "1778371200" },
        { podmanApi: fake.api },
      ).pipe(Stream.runCollect),
    );

    expect(fake.calls[0]?.path).toContain("since=1778371200");
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "streams logs from a live Podman service",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");

      await Effect.runPromise(bringUp(plan, { podmanApi: api }));
      try {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const chunks = await Effect.runPromise(
          logs(plan, { app: appId, service: node.name }, { follow: true, tail: 20 }, { podmanApi: api }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        );

        expect(collectLines(chunks).join("\n")).toContain("lando logs ready");
      } finally {
        await Effect.runPromise(bringDown(plan, { podmanApi: api }));
      }
    },
    60_000,
  );
});
