import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";
import { DateTime, Effect, Schema, Stream } from "effect";

import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { scopedDockerLogFileAccess } from "../src/log-file-access.ts";
import { serviceContainerName } from "../src/plan.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";
import { logs } from "../src/podman/logs.ts";

const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry.", env: {} } as const;
const providerId = ProviderId.make("lando");
const appId = AppId.make("logfollowapp");
const appRoot = AbsolutePath.make("/tmp/lando-log-follow-app");
const textEncoder = new TextEncoder();
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "logs-follow.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('ready')"],
  environment: {},
  mounts: [
    {
      type: "bind",
      source: appRoot,
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "passthrough",
      role: "app",
      excludes: [],
      includes: [],
    },
  ],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const FileLogSource = LogSource.members[0];
type FileLogSource = typeof FileLogSource.Type;

const source = (
  overrides: Partial<{
    readonly id: string;
    readonly path: string;
    readonly strategy: "follow" | "redirect";
    readonly stream: "stdout" | "stderr";
  }> = {},
): FileLogSource =>
  Schema.decodeUnknownSync(FileLogSource)({
    id: overrides.id ?? "app-log",
    path: overrides.path ?? "/var/log/app.log",
    stream: overrides.stream ?? "stderr",
    strategy: overrides.strategy ?? "follow",
  });

const makePlan = (logSources?: ReadonlyArray<FileLogSource>): AppPlan => {
  const service: ServicePlan = {
    ...node,
    ...(logSources === undefined ? {} : { logSources }),
  };
  return {
    id: appId,
    name: "Log Follow App",
    slug: "logfollowapp",
    root: appRoot,
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makeFakeApi = (...chunks: ReadonlyArray<Uint8Array>) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    stream: (request) => {
      calls.push(request);
      return Stream.fromIterable(chunks);
    },
  };

  return { api, calls };
};

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-05-14T00:00:00Z ${line}\n`);

const collect = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

// Podman's answers, byte for byte, to a request naming a missing container and to an engine fault.
const noSuchContainer = {
  status: "404 Not Found",
  body: JSON.stringify({
    cause: "no such container",
    message: 'no container with name or ID "lando-logfollowapp--node" found: no such container',
    response: 404,
  }),
} as const;
const engineFault = {
  status: "500 Internal Server Error",
  body: JSON.stringify({ cause: "storage", message: "reading container state: storage", response: 500 }),
} as const;

/** A Podman socket that gives every request one answer; records each request's method and path. */
const withEngine = async (
  answer: { readonly status: string; readonly body: string },
  run: (endpoint: string, requests: string[]) => Promise<void>,
) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-logs-engine-"));
  const endpoint = join(dir, "podman.sock");
  const requests: string[] = [];
  const server = createServer((socket) => {
    let head = "";
    socket.on("data", (chunk) => {
      if (head.includes("\r\n\r\n")) return;
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const [method, target] = head.split(" ");
      requests.push(`${method} ${target?.split("?")[0]}`);
      socket.end(
        `HTTP/1.1 ${answer.status}\r\nContent-Type: application/json\r\nContent-Length: ${answer.body.length}\r\n\r\n${answer.body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    await run(endpoint, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
};

/** Follows a service's console and file logs through the real Podman client and helper file access. */
const followThrough = (endpoint: string) => {
  const fileSource = source();
  const plan = makePlan([fileSource]);
  const api = makePodmanApiClient(endpoint, ctx);
  const logFileAccess = scopedDockerLogFileAccess({
    providerId: ctx.providerId,
    api,
    container: serviceContainerName(plan, node.name),
    resolveHelper: Effect.succeed({
      target: { os: "linux", arch: "x64" },
      path: AbsolutePath.make(import.meta.filename),
      digest: "1".repeat(64),
    }),
    sourceEnv: {},
  });
  return logs(
    plan,
    { app: appId, service: node.name },
    { follow: true, sources: [fileSource] },
    { api, logFileAccess, ctx },
  );
};

describe("podman log followers", () => {
  test("merges finite console and file-follow logs when follow is false", async () => {
    const fileSource = source();
    const plan = makePlan([fileSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(fileSource.path, "file ready\n");
    const fake = makeFakeApi(rawConsole("console ready"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [fileSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    const consoleChunk = chunks.find((chunk) => chunk.line === "console ready");
    const fileChunk = chunks.find((chunk) => chunk.line === "file ready");
    expect(consoleChunk?.source).toBeUndefined();
    expect(fileChunk?.source).toBe(fileSource.id);
    expect(fileChunk?.stream).toBe("stderr");
  });

  test("uses caller-provided log sources before plan-cached service sources", async () => {
    const staleSource = source({ id: "stale", path: "/var/log/stale.log" });
    const freshSource = source({ id: "fresh", path: "/var/log/fresh.log" });
    const plan = makePlan([staleSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(staleSource.path, "stale line\n");
    fs.writeFile(freshSource.path, "fresh line\n");
    const fake = makeFakeApi(rawConsole("console ready"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [freshSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.some((chunk) => chunk.line === "fresh line" && chunk.source === freshSource.id)).toBe(true);
    expect(chunks.some((chunk) => chunk.line === "stale line")).toBe(false);
  });

  test("streams only console logs when a service has no follow sources", async () => {
    const redirectSource = source({
      id: "redirected",
      path: "/var/log/redirected.log",
      strategy: "redirect",
    });
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(redirectSource.path, "redirected file\n");
    const fake = makeFakeApi(rawConsole("console only"));

    const chunks = await collect(
      logs(
        makePlan([redirectSource]),
        { app: appId, service: node.name },
        { follow: false, sources: [redirectSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.map((chunk) => chunk.line)).toEqual(["console only"]);
    expect(chunks[0]?.source).toBeUndefined();
  });

  test("restricts to a single declared source and suppresses console when options.source is set", async () => {
    const fileSource = source();
    const plan = makePlan([fileSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(fileSource.path, "file ready\n");
    const fake = makeFakeApi(rawConsole("console noise"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [fileSource], source: fileSource.id },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.map((chunk) => chunk.line)).toEqual(["file ready"]);
    expect(chunks.every((chunk) => chunk.source === fileSource.id)).toBe(true);
    expect(chunks.some((chunk) => chunk.line === "console noise")).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  test("ends without lines when following a planned service whose container does not exist", async () => {
    // Given an engine with no container for the service, as after destroy or before the first start
    await withEngine(noSuchContainer, async (endpoint, requests) => {
      // When following its console and file logs
      const chunks = await collect(followThrough(endpoint));

      // Then both followers end at the engine's 404, with no inspection first
      expect(chunks).toEqual([]);
      expect(requests.toSorted()).toEqual([
        "GET /v6.0.0/containers/lando-logfollowapp--node/logs",
        "POST /v6.0.0/containers/lando-logfollowapp--node/exec",
      ]);
    });
  });

  test("fails when the engine answers with an error other than a missing container", async () => {
    // Given an engine that fails every request
    await withEngine(engineFault, async (endpoint) => {
      // When following the service's logs
      const error = await Effect.runPromise(Stream.runCollect(followThrough(endpoint)).pipe(Effect.flip));

      // Then the failure surfaces instead of an empty stream
      expect(error).toBeInstanceOf(ProviderUnavailableError);
    });
  });

  test("tags a missing-api failure with the caller provider id and remediation", async () => {
    // Given a caller context for the podman provider and no engine API client
    // When
    const error = await Effect.runPromise(
      Stream.runCollect(logs(makePlan(), { app: appId, service: node.name }, {}, { ctx })).pipe(Effect.flip),
    );

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ _tag: "ProviderUnavailableError", providerId: "podman" });
    expect(error.message).toContain("provider-podman");
    expect(error.remediation).toBe(ctx.remediation);
  });
});
