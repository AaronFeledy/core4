import { describe, expect, test } from "bun:test";

import { Chunk, Effect, Stream } from "effect";

import { AbsolutePath, AppId, type LogSource, LogSourceId, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { runtimeFollowLogSources } from "../../src/services/redirect-log-sources.ts";

const redirectSource = (id: string, path: string, stream: LogSource["stream"]): LogSource => ({
  id: LogSourceId.make(id),
  path: AbsolutePath.make(path),
  stream,
  strategy: "redirect",
  required: false,
  timestamps: false,
});

describe("redirect log source round-trip", () => {
  test("schedules no follower for a redirect-only service", () => {
    const sources = [
      redirectSource("access", "/usr/local/apache2/logs/access_log", "stdout"),
      redirectSource("error", "/usr/local/apache2/logs/error_log", "stderr"),
    ];

    expect(runtimeFollowLogSources(sources)).toEqual([]);
  });

  test("delivers redirected lines through the implicit console stream", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        TestRuntimeProvider.logs(
          { app: AppId.make("logs-app"), service: ServiceName.make("web") },
          { follow: false },
        ),
      ),
    );

    const first = Chunk.toReadonlyArray(chunks)[0];
    expect(first?.source).toBeUndefined();
    expect(first?.stream).toBe("stdout");
    expect(first?.line).toBe("ready");
  });
});
