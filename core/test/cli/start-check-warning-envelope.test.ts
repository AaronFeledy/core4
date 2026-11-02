import { expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { runPostStartScan } from "@lando/engine/operations/post-start-scan";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { StartAppResult } from "@lando/sdk/schema";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  CommandResultEnvelope,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { EventService, type UrlScannerShape } from "@lando/sdk/services";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const service = ServiceName.make("web");
const url = "http://localhost:8080/";
const plan: AppPlan = {
  id: AppId.make("check-envelope"),
  name: "check-envelope",
  slug: "check-envelope",
  root: AbsolutePath.make("/fixture"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
};

test.each(["app-error", "service-error", "lando-error"] as const)(
  "%s produces only owner-appropriate JSON warnings",
  async (verdict) => {
    const io = createBufferedRendererIO();
    const scanner: UrlScannerShape = {
      id: "fixture",
      scan: (appId) =>
        Effect.succeed({
          appId,
          endpoints: [
            {
              service,
              url,
              verdict,
              reachable: verdict !== "lando-error",
              statusCode: verdict === "app-error" ? 500 : 502,
              detail: "connection refused",
            },
          ],
        }),
      detectCollisions: () => Effect.succeed([]),
    };
    const command = Effect.gen(function* () {
      const events = yield* EventService;
      const checks = yield* runPostStartScan({ scanner, plan, events, urls: [{ service, url }] });
      return { app: plan.name, servicesStarted: [], checks };
    });
    await runWithRendererHandling(command, {
      runtime: LandoEventService.layerRuntime,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:start",
      resultSchema: StartAppResult,
      io,
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
    });
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(
      verdict === "lando-error"
        ? [
            {
              code: "LANDO_MESSAGE_WARN",
              message: `Lando could not reach ${url}: connection refused`,
            },
          ]
        : [],
    );
    const result = Schema.decodeUnknownSync(StartAppResult)(envelope.result);
    expect(result.checks?.[0]?.verdict).toBe(verdict);
  },
);
