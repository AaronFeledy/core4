import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { observeTlsPeer } from "@lando/http-client/tls-peer";
import { LEAF_RENEWAL_MARGIN_MS, certificateIsCurrent } from "@lando/sdk/certificates";
import { type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Clock, Effect } from "effect";
import { liveTraefikFixture, liveTraefikLayers } from "./live-traefik-fixture.ts";
import { routeOwner } from "./route-owner-fixture.ts";
import pem from "./router-certificate-fixtures.json";

const socket = resolveLiveProviderSocket();

test.skipIf(socket === undefined)(
  "publishes rotated certificates through real Traefik and reuses them on a fresh warm apply",
  async () => {
    if (socket === undefined) throw new TypeError("Missing explicit answering Podman socket");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* liveTraefikFixture(socket.socketPath);
          const owner = routeOwner("certificate-live");
          const routes: readonly RoutePlan[] = [
            {
              hostname: "app.test.lndo.site",
              scheme: "https",
              priority: 100000,
              service: ServiceName.make("web"),
              backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
            },
          ];
          const service = fixture.makeService();
          if (service.prepare === undefined) throw new TypeError("Traefik preparation is required");
          yield* service.prepare(fixture.config);
          const peer = () =>
            observeTlsPeer({
              hostname: "app.test.lndo.site",
              address: "127.0.0.1",
              port: fixture.httpsPort,
              caPems: [fixture.authority.root],
            });
          yield* service.applyRoutes(routes, owner);
          const original = new X509Certificate(yield* peer()).fingerprint256;
          fixture.authority.root = pem.rootB;
          fixture.authority.pair = pem.rotated;
          yield* service.applyRoutes(routes, owner);
          const replacementPem = yield* peer();
          const replacement = new X509Certificate(replacementPem).fingerprint256;
          expect(replacement).not.toBe(original);
          expect(
            certificateIsCurrent(replacementPem, {
              names: ["app.test.lndo.site"],
              root: pem.rootB,
              now: yield* Clock.currentTimeMillis,
              renewalMarginMs: LEAF_RENEWAL_MARGIN_MS,
            }),
          ).toBe(true);
          expect(fixture.counts.issues).toBe(4);

          const before = { ...fixture.counts };
          const started = performance.now();
          yield* fixture.makeService().applyRoutes(routes, owner);
          const elapsedMs = performance.now() - started;
          const warm = {
            writes: fixture.counts.writes - before.writes,
            issues: fixture.counts.issues - before.issues,
            roots: fixture.counts.roots - before.roots,
            requests: fixture.counts.requests - before.requests,
          };
          expect(warm).toEqual({ writes: 0, issues: 0, roots: 1, requests: 2 });
          expect(new X509Certificate(yield* peer()).fingerprint256).toBe(replacement);
          console.info(
            "Traefik live warm apply",
            JSON.stringify({ elapsedMs, ...warm, original, replacement }),
          );
        }).pipe(Effect.provide(liveTraefikLayers)),
      ),
    );
  },
  120000,
);
