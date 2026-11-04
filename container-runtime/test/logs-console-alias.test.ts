import { expect, test } from "bun:test";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  LogSourceId,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { DateTime, Effect, Schema, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { logs } from "../src/podman/logs.ts";

const ctx = { providerId: "podman", remediation: "Run lando setup.", env: {} } as const;
const app = AppId.make("console-alias");
const service = ServiceName.make("web");
const provider = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const planFor = (logSources: readonly LogSource[]): AppPlan => ({
  id: app,
  name: "console-alias",
  slug: "console-alias",
  root: AbsolutePath.make("/tmp/console-alias"),
  provider,
  metadata,
  extensions: {},
  routes: [],
  stores: [],
  fileSync: [],
  services: {
    [service]: {
      name: service,
      type: "php",
      provider,
      primary: true,
      artifact: { kind: "ref", ref: "php:8.3" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
      logSources,
    },
  },
});
const alias = (id: string, stream: "stdout" | "stderr", strategy: "console" | "redirect" = "console") =>
  Schema.decodeUnknownSync(LogSource)({
    id,
    stream,
    strategy,
    ...(strategy === "redirect" ? { path: "/var/log/access.log" } : {}),
  });
const frame = (pipe: 1 | 2, text: string): Uint8Array => {
  const payload = new TextEncoder().encode(`2026-05-14T00:00:00Z ${text}\n`);
  const bytes = new Uint8Array(8 + payload.length);
  bytes[0] = pipe;
  new DataView(bytes.buffer).setUint32(4, payload.length);
  bytes.set(payload, 8);
  return bytes;
};

test.each(["console", "redirect"] as const)(
  "selects the daemon pipe before tail/since for %s sources",
  async (strategy) => {
    // Given a mixed daemon response, even if the daemon ignores the requested pipe.
    const source = alias("access", "stdout", strategy);
    const calls: EngineHttpRequest[] = [];
    let acquisitions = 0;
    const api: EngineHttpApi = {
      stream: (request) => {
        calls.push(request);
        return Stream.make(frame(2, "error noise"), frame(1, "last access"));
      },
    };
    // When selecting the last access line since an instant.
    const result = await Effect.runPromise(
      Stream.runCollect(
        logs(
          planFor([source]),
          { app, service },
          {
            source: source.id,
            sources: [source],
            follow: false,
            tail: 1,
            since: "1778716800",
          },
          {
            api,
            ctx,
            logFileAccess: Effect.sync(() => {
              acquisitions++;
              return makeMemoryLogFileAccess().access;
            }),
          },
        ),
      ),
    );
    // Then selection happens in the daemon request and provenance survives defensive filtering.
    const query = new URL(calls[0]?.path ?? "", "http://daemon").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      stdout: "true",
      stderr: "false",
      follow: "false",
      timestamps: "true",
      tail: "1",
      since: "1778716800",
    });
    expect(
      [...result].map(({ line, stream, source: id, timestamp }) => ({
        line,
        stream,
        id,
        timestamp: timestamp?.toISOString(),
      })),
    ).toEqual([
      {
        line: "last access",
        stream: "stdout",
        id: LogSourceId.make("access"),
        timestamp: "2026-05-14T00:00:00.000Z",
      },
    ]);
    expect(acquisitions).toBe(0);
  },
);

test("follows a shared stderr pipe under either alias and releases the subscription on cancellation", async () => {
  // Given two aliases sharing stderr and a never-ending daemon stream.
  const sources = [alias("access", "stderr"), alias("error", "stderr")];
  let opened = 0;
  let closed = 0;
  const requests: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    stream: (request) => {
      requests.push(request);
      return Stream.unwrap(
        Effect.sync(() => {
          opened++;
          return Stream.concat(Stream.make(frame(1, "noise"), frame(2, "shared line")), Stream.never).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                closed++;
              }),
            ),
          );
        }),
      );
    },
  };
  // When consuming one follow line through each logical name.
  const results = await Promise.all(
    sources.map((source) =>
      Effect.runPromise(
        Stream.runCollect(
          logs(
            planFor(sources),
            { app, service },
            { source: source.id, follow: true, tail: 0, since: "1778716800" },
            { api, ctx },
          ).pipe(Stream.take(1)),
        ),
      ),
    ),
  );
  // Then both select the same pipe without acquiring a second stream for either alias.
  expect(results.map((result) => [...result].map(({ line, source }) => ({ line, source })))).toEqual([
    [{ line: "shared line", source: LogSourceId.make("access") }],
    [{ line: "shared line", source: LogSourceId.make("error") }],
  ]);
  expect(opened).toBe(2);
  expect(closed).toBe(2);
  expect(
    requests.every(({ path }) => {
      const query = new URL(path, "http://daemon").searchParams;
      return (
        query.get("stdout") === "false" &&
        query.get("stderr") === "true" &&
        query.get("follow") === "true" &&
        query.get("tail") === "0" &&
        query.get("since") === "1778716800"
      );
    }),
  ).toBe(true);
});

test("subscribes to unfiltered console once plus genuine files, never once per alias", async () => {
  // Given duplicate pipe aliases and a real authored file.
  const file = Schema.decodeUnknownSync(LogSource)({
    id: "custom",
    strategy: "follow",
    path: "/app/custom.log",
    stream: "stderr",
  });
  const fs = makeMemoryLogFileAccess();
  fs.writeFile("/app/custom.log", "file line\n");
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    stream: (request) => {
      calls.push(request);
      return Stream.make(frame(1, "out"), frame(2, "err"));
    },
  };
  // When collecting all logs.
  const result = await Effect.runPromise(
    Stream.runCollect(
      logs(
        planFor([alias("access", "stderr"), alias("error", "stderr"), file]),
        { app, service },
        { follow: false },
        { api, ctx, logFileAccess: fs.access },
      ),
    ),
  );
  // Then native lines remain unaliased and the real file retains provenance.
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]?.path ?? "", "http://daemon").searchParams.get("stdout")).toBe("true");
  expect(new URL(calls[0]?.path ?? "", "http://daemon").searchParams.get("stderr")).toBe("true");
  expect(
    [...result].map(({ line, source }) => ({ line, source })).sort((a, b) => a.line.localeCompare(b.line)),
  ).toEqual([
    { line: "err", source: undefined },
    { line: "file line", source: LogSourceId.make("custom") },
    { line: "out", source: undefined },
  ]);
});

test("does not fall back to console when the service lacks the selected source", async () => {
  // Given a source declared by another service only.
  const requested = alias("access", "stdout");
  let opened = 0;
  const api: EngineHttpApi = {
    stream: () => {
      opened++;
      return Stream.make(frame(1, "unrelated"));
    },
  };
  // When selecting it against a service with no such source.
  const result = await Effect.runPromise(
    Stream.runCollect(
      logs(planFor([]), { app, service }, { source: requested.id, follow: false }, { api, ctx }),
    ),
  );
  // Then no unrelated console subscription or output is produced.
  expect([...result]).toEqual([]);
  expect(opened).toBe(0);
});
