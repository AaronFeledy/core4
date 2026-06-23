import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { LandoEvent } from "../../src/events/index.ts";
import {
  PluginManifest,
  TunnelCapabilities,
  TunnelSession,
  TunnelStartRequest,
  TunnelStatus,
  TunnelStatusRequest,
  TunnelStopRequest,
  TunnelTarget,
  getJsonSchema,
} from "../../src/schema/index.ts";

type JsonSchemaNode = {
  readonly properties?: Record<string, { readonly enum?: ReadonlyArray<string>; readonly pattern?: string }>;
};

describe("tunnel SDK schemas", () => {
  test("decodes tunnel targets, sessions, events, and manifest contributions", () => {
    const capabilities = Schema.decodeUnknownSync(TunnelCapabilities)({
      connectorBinary: true,
      ephemeralUrls: true,
      stableUrls: false,
      basicAuth: true,
      detached: true,
    });

    expect(capabilities.connectorBinary).toBe(true);
    expect(
      Schema.decodeUnknownSync(TunnelTarget)({ _tag: "route", routeId: "https", hostname: "app.lndo.site" })
        ._tag,
    ).toBe("route");
    expect(
      Schema.decodeUnknownSync(TunnelTarget)({
        _tag: "service",
        service: "appserver",
        port: 8080,
        protocol: "http",
      })._tag,
    ).toBe("service");
    expect(
      Schema.decodeUnknownSync(TunnelTarget)({ _tag: "loopback", url: "http://127.0.0.1:8888" })._tag,
    ).toBe("loopback");
    expect(
      Schema.decodeUnknownSync(TunnelStartRequest)({
        app: "my-app",
        target: { _tag: "route", routeId: "https" },
        provider: "quick",
        detached: true,
      }).detached,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(TunnelStopRequest)({ sessionId: "tun_1", provider: "quick" }).sessionId,
    ).toBe("tun_1");
    expect(Schema.decodeUnknownSync(TunnelStatusRequest)({ sessionId: "tun_1" }).sessionId).toBe("tun_1");
    expect(Schema.decodeUnknownSync(TunnelStatus)("ready")).toBe("ready");
    expect(
      Schema.decodeUnknownSync(TunnelSession)({
        id: "tun_1",
        app: "my-app",
        provider: "quick",
        target: { _tag: "route", routeId: "https" },
        publicUrl: "https://public.example.test",
        status: "ready",
        detached: true,
        startedAt: "2026-06-14T00:00:00.000Z",
      }).status,
    ).toBe("ready");
    const readyEvent = Schema.decodeUnknownSync(LandoEvent)({
      _tag: "tunnel-ready",
      eventName: "tunnel-ready",
      app: "my-app",
      provider: "quick",
      sessionId: "tun_1",
      targetSummary: "route:https",
      detached: true,
      status: "ready",
      publicUrlSummary: "https://[redacted]",
      timestamp: "2026-06-14T00:00:00.000Z",
    });
    expect(readyEvent._tag).toBe("tunnel-ready");
    expect(
      Schema.decodeUnknownSync(PluginManifest)({
        name: "@lando/tunnel-quick",
        version: "1.0.0",
        api: 4,
        contributes: {
          tunnelServices: [{ id: "quick", module: "./tunnel.ts", capabilities }],
        },
      }).contributes?.tunnelServices?.[0]?.id,
    ).toBe("quick");
    const tunnelTargetSchema = getJsonSchema("TunnelTarget") as {
      readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
    };
    const loopbackBranch = tunnelTargetSchema.anyOf?.find((branch) =>
      branch.properties?._tag?.enum?.includes("loopback"),
    );
    expect(loopbackBranch?.properties?.url?.pattern).toContain("localhost");
    expect(loopbackBranch?.properties?.url?.pattern).toContain("127\\.0\\.0\\.1");
  });

  test("rejects invalid tunnel status and malformed target shapes", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(TunnelStatus)("exposed"))).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(TunnelTarget)({ _tag: "hostPort", port: 8080 }))).toBe(
      true,
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(TunnelTarget)({ _tag: "route", routeId: "" }))).toBe(
      true,
    );
    expect(
      Either.isLeft(Schema.decodeUnknownEither(TunnelTarget)({ _tag: "service", service: "web", port: 0 })),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(TunnelTarget)({ _tag: "service", service: "web", port: 3.14 }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(TunnelTarget)({ _tag: "loopback", url: "https://example.test" }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(Schema.decodeUnknownEither(TunnelTarget)({ _tag: "loopback", url: "not-a-url" })),
    ).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(TunnelStartRequest)({ app: "my-app" }))).toBe(true);
  });
});
