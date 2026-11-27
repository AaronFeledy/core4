import { expect, test } from "bun:test";
import { Effect } from "effect";
import { prepareRouteUrlBindings } from "../../src/lifecycle/route-url-bindings.ts";
import { recordRouteUrlEvidence, recordedRouteFacts } from "../../src/lifecycle/route-url-evidence.ts";
import { web } from "../operations/start-progress-topology-support.ts";
import { publicUrlRouter, urlReadingPlan } from "./route-url-fixture.ts";

test.each([
  ["https", 8443, "https://web.test:8443", "8443"],
  ["https", 443, "https://web.test", "443"],
  ["http", 80, "http://web.test", "80"],
] as const)("recovers recorded route facts for %s on %s", async (scheme, port, origin, publicPort) => {
  const router =
    port === 8443
      ? publicUrlRouter()
      : {
          ...publicUrlRouter(),
          routeAuthorities: () => Effect.succeed([{ hostname: "web.test", scheme, port }]),
        };
  const plan =
    scheme === "https"
      ? urlReadingPlan
      : {
          ...urlReadingPlan,
          routes: urlReadingPlan.routes
            .filter((route) => route.hostname === "web.test")
            .map((route) => ({ ...route, scheme })),
        };
  const proof = await Effect.runPromise(prepareRouteUrlBindings({ plan, routes: plan.routes, router }));
  const consumer = recordRouteUrlEvidence(plan, plan, proof).services[web.name];

  expect(consumer?.extensions["@lando/engine/realized-route-urls"]).toEqual({
    web: `${origin}/app`,
  });
  expect(consumer && recordedRouteFacts(consumer, web.name)).toEqual({
    url: `${origin}/app`,
    hostname: "web.test",
    origin,
    publicPort,
    scheme,
  });
});

test("finds no route facts for a consumer with no recorded evidence", () => {
  expect(recordedRouteFacts(web, web.name)).toBeUndefined();
});
