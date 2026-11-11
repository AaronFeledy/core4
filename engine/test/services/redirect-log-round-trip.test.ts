import { describe, expect, test } from "bun:test";
import { AbsolutePath, AppId, AppPlan, type LogSource, LogSourceId, ServiceName } from "@lando/sdk/schema";
import { makeTestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema, Stream } from "effect";

import { runtimeFollowLogSources } from "../../src/services/redirect-log-sources";

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
    const provider = makeTestRuntimeProvider();
    const metadata = { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 };
    const plan = Schema.decodeUnknownSync(AppPlan)({
      id: "logs-app",
      name: "logs-app",
      slug: "logs-app",
      root: "/tmp/logs-app",
      provider: "test",
      services: {
        web: {
          name: "web",
          type: "node",
          provider: "test",
          primary: true,
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        },
      },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    });
    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        provider.logs({ app: AppId.make("logs-app"), service: ServiceName.make("web") }, { follow: false }),
      ),
    );

    const first = chunks[0];
    expect(first?.source).toBeUndefined();
    expect(first?.stream).toBe("stdout");
    expect(first?.line).toBe("ready");
  });
});
