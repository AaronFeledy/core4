import { expect, test } from "bun:test";
import type { RoutePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import { backendTransportName, planBackendTransports } from "../src/backend-transport.ts";
import { routeFile } from "../src/proxy-paths.ts";
import { renderTraefikDynamicConfig, routeNamespace } from "../src/routing.ts";
import { type liveGraph, makeObserveFixture } from "./observe-routes-fixture.ts";
import { routeObjectName, routeOwner } from "./route-owner-fixture.ts";

const app = routeOwner("tls-observe");
const serviceName = routeObjectName(app, 0);
const routerHttp = `${serviceName}-http@file`;
const routerHttps = `${serviceName}-https@file`;
const ROOT = TEST_CERTIFICATES.rootA;

const route: RoutePlan = {
  hostname: "secure.example.test",
  priority: 2,
  scheme: "both",
  service: ServiceName.make("web"),
  backend: {
    service: ServiceName.make("web"),
    protocol: "https",
    port: 443,
    host: "web.app.internal",
    tls: { caId: "mkcert", serverName: "web.app.internal" },
  },
};

const graphWith = (service: Record<string, unknown>) =>
  ({
    routers: {
      [routerHttp]: {
        rule: 'Host("secure.example.test")',
        service: serviceName,
        entryPoints: ["web"],
        using: ["web"],
        priority: 2,
        status: "enabled",
      },
      [routerHttps]: {
        rule: 'Host("secure.example.test")',
        service: serviceName,
        entryPoints: ["websecure"],
        using: ["websecure"],
        priority: 2,
        tls: {},
        status: "enabled",
      },
    },
    services: { [`${serviceName}@file`]: service },
  }) as unknown as ReturnType<typeof liveGraph>;

const fixtureFor = (input: { readonly yaml?: string; readonly service: Record<string, unknown> }) => {
  const fixture = makeObserveFixture(graphWith(input.service));
  if (input.yaml !== undefined) {
    fixture.files.set(routeFile(fixture.paths, app), input.yaml);
  }
  return fixture;
};

const published = () => {
  const plan = planBackendTransports([route], app, ROOT);
  const name = plan.references[0];
  if (name === undefined) throw new Error("expected a transport reference");
  return {
    name,
    yaml: renderTraefikDynamicConfig([route], app, undefined, plan),
    service: {
      loadBalancer: {
        servers: [{ url: "https://web.app.internal:443" }],
        passHostHeader: true,
        serversTransport: `${name}@file`,
      },
      status: "enabled",
    },
  };
};

test("observes a managed backend transport from the owned YAML and loaded reference", async () => {
  // Given
  const p = published();
  const fixture = fixtureFor({ yaml: p.yaml, service: p.service });
  // When
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  // Then
  expect(evidence.observation.status).toBe("present");
  expect(fixture.mutations).toEqual([]);
});

test("observes one service's managed route while the owned file holds another service's transport", async () => {
  // Given: `lando open` observes one service's routes; the owner's file also
  // publishes a second native-TLS service.
  const other: RoutePlan = {
    ...route,
    hostname: "api.example.test",
    service: ServiceName.make("api"),
    backend: {
      service: ServiceName.make("api"),
      protocol: "https",
      port: 443,
      host: "api.app.internal",
      tls: { caId: "mkcert", serverName: "api.app.internal" },
    },
  };
  const plan = planBackendTransports([route, other], app, ROOT);
  const fixture = fixtureFor({
    yaml: renderTraefikDynamicConfig([route, other], app, undefined, plan),
    service: {
      loadBalancer: {
        servers: [{ url: "https://web.app.internal:443" }],
        passHostHeader: true,
        serversTransport: `${plan.references[0]}@file`,
      },
      status: "enabled",
    },
  });
  // When
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  // Then
  expect(plan.transports).toHaveLength(2);
  expect(evidence.observation.status).toBe("present");
});

test.each([
  {
    label: "a body edited under an unchanged name",
    mutate: (yaml: string) => yaml.replace(JSON.stringify(ROOT), JSON.stringify(TEST_CERTIFICATES.rootB)),
  },
  {
    label: "a missing transport registration",
    mutate: (yaml: string) => yaml.replace(/\n {2}serversTransports:[\s\S]*$/u, "\n"),
  },
  {
    label: "a missing ownership metadata line",
    mutate: (yaml: string) => yaml.replace(/^# lando-route-file: .*\n/u, ""),
  },
])("observes unknown for $label", async ({ mutate }) => {
  const p = published();
  const fixture = fixtureFor({ yaml: mutate(p.yaml), service: p.service });
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence.observation.status).toBe("unknown");
});

test.each([
  { label: "an empty root list", rootCAs: [] },
  { label: "unusable root material", rootCAs: ["not a certificate"] },
])("observes unknown for a consistently named and loaded transport with $label", async ({ rootCAs }) => {
  // Given: the name matches the body's own content address and the router loaded it.
  const config = { serverName: "web.app.internal", rootCAs, insecureSkipVerify: false as const };
  const name = backendTransportName(routeNamespace(app), "mkcert", config);
  const yaml = renderTraefikDynamicConfig([route], app, undefined, {
    transports: [{ name, caId: "mkcert", config }],
    references: [name],
    invalidRoot: false,
  });
  const fixture = fixtureFor({
    yaml,
    service: {
      loadBalancer: {
        servers: [{ url: "https://web.app.internal:443" }],
        passHostHeader: true,
        serversTransport: `${name}@file`,
      },
      status: "enabled",
    },
  });
  // When
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  // Then
  expect(evidence.observation.status).toBe("unknown");
});

test("does not treat a loaded reference to another transport as present", async () => {
  // Given
  const p = published();
  const fixture = fixtureFor({
    yaml: p.yaml,
    service: {
      ...p.service,
      loadBalancer: { ...(p.service.loadBalancer as object), serversTransport: "route-other-tls-abc@file" },
    },
  });
  // When
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  // Then
  expect(evidence.observation.status).toBe("missing");
});

test("does not treat an unexpected transport reference on a plain backend as present", async () => {
  // Given
  const plain: RoutePlan = {
    ...route,
    scheme: "https",
    backend: { service: ServiceName.make("web"), protocol: "http", port: 80 },
  };
  const fixture = makeObserveFixture({
    routers: {
      [`${serviceName}-https@file`]: {
        rule: 'Host("secure.example.test")',
        service: serviceName,
        entryPoints: ["websecure"],
        using: ["websecure"],
        priority: 2,
        tls: {},
        status: "enabled",
      },
    },
    services: {
      [`${serviceName}@file`]: {
        loadBalancer: {
          servers: [{ url: "http://web.tls-observe.internal:80" }],
          passHostHeader: true,
          serversTransport: "route-other-tls-abc@file",
        },
        status: "enabled",
      },
    },
  } as unknown as ReturnType<typeof liveGraph>);
  // When
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [plain]));
  // Then
  expect(evidence.observation.status).toBe("missing");
});
