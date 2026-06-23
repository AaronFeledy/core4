import { DateTime, Effect } from "effect";

import { TunnelTargetUnresolvedError } from "@lando/sdk/errors";
import type { DownloadRequest, TunnelSession, TunnelTarget } from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import type { LandoEvent, TunnelServiceShape } from "@lando/sdk/services";
import type {
  TunnelServiceContractObservations,
  TunnelServiceDetachedStateRecord,
  TunnelServiceEgressRecord,
  TunnelServiceFinalizerRecord,
  TunnelServiceProbeRecord,
  TunnelServiceToolProvisionRecord,
} from "@lando/sdk/test";

const TUNNEL_SECRET = "TUNNEL-CONTRACT-SECRET-7f2e";
const TIMESTAMP = DateTime.unsafeMake("2026-06-01T00:00:00.000Z");

const redactor = createSecretRedactor([TUNNEL_SECRET]);

const event = (value: LandoEvent): LandoEvent =>
  JSON.parse(redactor.redact(JSON.stringify(value))) as LandoEvent;

const targetSummary = (target: TunnelTarget): string => {
  switch (target._tag) {
    case "route":
      return `route:${target.routeId}`;
    case "service":
      return `service:${target.service}:${target.port}`;
    case "loopback":
      return `loopback:${target.url}`;
  }
};

const supportedTarget = (target: TunnelTarget): boolean =>
  target._tag === "route" || target._tag === "service" || target.url.startsWith("http://127.0.0.1:");

export interface TestTunnelServiceHandle {
  readonly service: TunnelServiceShape;
  readonly unsupportedTarget: TunnelTarget;
  readonly observations: TunnelServiceContractObservations;
  readonly events: () => ReadonlyArray<LandoEvent>;
}

export const makeTestTunnelService = () =>
  Effect.sync((): TestTunnelServiceHandle => {
    const captured: Array<LandoEvent> = [];
    const sessions = new Map<string, TunnelSession>();
    const egress: Array<TunnelServiceEgressRecord> = [];
    const tools: Array<TunnelServiceToolProvisionRecord> = [];
    const finalizers: Array<TunnelServiceFinalizerRecord> = [];
    const detached: Array<TunnelServiceDetachedStateRecord> = [];
    const probes: Array<TunnelServiceProbeRecord> = [];
    const dataMoverUses: Array<unknown> = [];
    let nextId = 1;

    const service: TunnelServiceShape = {
      id: "test-tunnel",
      capabilities: {
        connectorBinary: true,
        ephemeralUrls: true,
        stableUrls: false,
        basicAuth: true,
        detached: true,
      },
      start: (request) => {
        if (!supportedTarget(request.target)) {
          return Effect.fail(
            new TunnelTargetUnresolvedError({
              message: "Unsupported tunnel target",
              provider: "test-tunnel",
              remediation: "Use a route, service endpoint, or core-created loopback target.",
            }),
          );
        }

        return Effect.gen(function* () {
          const sessionId = `tun_${nextId++}`;
          const detachedMode = request.detached === true;
          const publicUrl = `https://${TUNNEL_SECRET}.public.example.test/${sessionId}`;
          const summary = targetSummary(request.target);
          captured.push(
            event({
              _tag: "pre-tunnel-start",
              eventName: "pre-tunnel-start",
              app: request.app,
              provider: service.id,
              targetSummary: summary,
              detached: detachedMode,
              timestamp: TIMESTAMP,
            }),
          );
          egress.push({
            url: `https://api.example.test/${TUNNEL_SECRET}/sessions`,
            callerId: "tunnel-start",
          });
          tools.push({
            request: {
              url: "https://tools.example.test/cloudflared.tar.gz",
              destination: { kind: "memory" },
              callerId: "tunnel-tool-provision",
              redactionTokens: [TUNNEL_SECRET],
            } satisfies DownloadRequest,
          });
          probes.push({ sessionId, publicUrl });
          const session: TunnelSession = {
            id: sessionId,
            app: request.app,
            provider: service.id,
            target: request.target,
            publicUrl,
            status: "ready",
            detached: detachedMode,
            startedAt: "2026-06-01T00:00:00.000Z",
          };
          sessions.set(sessionId, session);
          if (detachedMode) detached.push({ operation: "record", sessionId });
          captured.push(
            event({
              _tag: "post-tunnel-start",
              eventName: "post-tunnel-start",
              app: request.app,
              provider: service.id,
              sessionId,
              targetSummary: summary,
              detached: detachedMode,
              publicUrlSummary: publicUrl,
              timestamp: TIMESTAMP,
              outcome: "success",
              durationMs: 1,
            }),
          );
          captured.push(
            event({
              _tag: "tunnel-ready",
              eventName: "tunnel-ready",
              app: request.app,
              provider: service.id,
              sessionId,
              targetSummary: summary,
              detached: detachedMode,
              publicUrlSummary: publicUrl,
              timestamp: TIMESTAMP,
              status: "ready",
            }),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalizers.push({ sessionId, provider: service.id });
            }),
          );
          return session;
        });
      },
      stop: (request) =>
        Effect.sync(() => {
          const current = sessions.get(request.sessionId);
          if (current === undefined) return;
          captured.push(
            event({
              _tag: "pre-tunnel-stop",
              eventName: "pre-tunnel-stop",
              app: current.app,
              provider: current.provider,
              sessionId: current.id,
              targetSummary: targetSummary(current.target),
              detached: current.detached,
              publicUrlSummary: current.publicUrl,
              timestamp: TIMESTAMP,
            }),
          );
          sessions.set(current.id, { ...current, status: "stopped", updatedAt: "2026-06-01T00:00:01.000Z" });
          detached.push({ operation: "remove", sessionId: current.id });
          captured.push(
            event({
              _tag: "post-tunnel-stop",
              eventName: "post-tunnel-stop",
              app: current.app,
              provider: current.provider,
              sessionId: current.id,
              targetSummary: targetSummary(current.target),
              detached: current.detached,
              publicUrlSummary: current.publicUrl,
              timestamp: TIMESTAMP,
              outcome: "success",
              durationMs: 1,
            }),
          );
        }),
      status: (request) =>
        Effect.sync(() => {
          const current = sessions.get(request.sessionId);
          if (current === undefined) return "unknown";
          detached.push({ operation: "reconcile", sessionId: current.id });
          captured.push(
            event({
              _tag: "tunnel-status",
              eventName: "tunnel-status",
              app: current.app,
              provider: current.provider,
              sessionId: current.id,
              targetSummary: targetSummary(current.target),
              detached: current.detached,
              publicUrlSummary: current.publicUrl,
              timestamp: TIMESTAMP,
              status: current.status,
            }),
          );
          return current.status;
        }),
      list: (filter) =>
        Effect.sync(() =>
          [...sessions.values()].filter(
            (session) =>
              (filter?.app === undefined || filter.app === session.app) &&
              (filter?.provider === undefined || filter.provider === session.provider) &&
              (filter?.sessionId === undefined || filter.sessionId === session.id) &&
              (filter?.detached === undefined || filter.detached === session.detached) &&
              (filter?.status === undefined || filter.status === session.status),
          ),
        ),
    };

    return {
      service,
      unsupportedTarget: { _tag: "loopback", url: "http://0.0.0.0:9999" },
      observations: {
        egressRequests: () => Effect.sync(() => [...egress]),
        toolProvisions: () => Effect.sync(() => [...tools]),
        finalizers: () => Effect.sync(() => [...finalizers]),
        detachedState: () => Effect.sync(() => [...detached]),
        probes: () => Effect.sync(() => [...probes]),
        dataMoverUses: () => Effect.sync(() => [...dataMoverUses]),
        redactionTokens: [TUNNEL_SECRET],
      },
      events: () => [...captured],
    };
  });

export const TestTunnelService: TestTunnelServiceHandle = makeTestTunnelService().pipe(Effect.runSync);
