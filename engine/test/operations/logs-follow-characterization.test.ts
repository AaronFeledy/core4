import { describe, expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame, followLogsForPlan } from "../../src/operations/logs.ts";

const providerId = ProviderId.make("test");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-21T00:00:00Z"),
  source: "follow-characterization",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: AppId.make("follow-characterization"),
  name: "Follow App",
  slug: "follow-app",
  root: AbsolutePath.make("/tmp/lando-follow-characterization"),
  provider: providerId,
  services: Object.fromEntries(
    ["web", "database"].map((id) => {
      const name = ServiceName.make(id);
      return [
        name,
        {
          name,
          type: "node",
          provider: providerId,
          primary: id === "web",
          artifact: { kind: "ref", ref: "node:22-alpine" },
          command: [],
          environment: {},
          mounts: [],
          storage: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        },
      ];
    }),
  ),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("log-follow completion", () => {
  for (const mode of ["finite", "empty", "abort"] as const) {
    test(`${mode} streams finish and release every provider stream`, async () => {
      const frames: StreamFrameSinkFrame[] = [];
      const released: string[] = [];
      const controller = new AbortController();
      const provider: RuntimeProviderShape = {
        ...TestRuntimeProvider,
        logs: (target, options) => {
          expect(options.follow).toBe(true);
          expect(target.plan).toBe(plan);
          const chunk = {
            service: target.service,
            stream: "stdout" as const,
            line: `${target.service} ready`,
          };
          const stream =
            mode === "empty"
              ? Stream.empty
              : mode === "abort"
                ? Stream.concat(Stream.make(chunk), Stream.fromEffect(Effect.never))
                : Stream.make(chunk);
          return stream.pipe(
            Stream.ensuring(
              Effect.sync(() => {
                released.push(String(target.service));
              }),
            ),
          );
        },
      };
      const layer = Layer.merge(
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Layer.succeed(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              frames.push(frame);
              if (mode === "abort" && frames.length === 2) controller.abort();
            }),
        }),
      );

      const result = await Effect.runPromise(
        followLogsForPlan(plan, { signal: controller.signal }).pipe(Effect.provide(layer)),
      );

      expect(result).toEqual({ app: "Follow App", lines: [] });
      expect(released.sort()).toEqual(["database", "web"]);
      expect(frames.sort((a, b) => (a.service ?? "").localeCompare(b.service ?? ""))).toEqual(
        mode === "empty"
          ? []
          : [
              { _tag: "stdout", chunk: "database ready", service: "database" },
              { _tag: "stdout", chunk: "web ready", service: "web" },
            ],
      );
    });
  }
});
