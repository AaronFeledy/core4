import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import traefikGlobalService, {
  TRAEFIK_DASHBOARD_HOSTNAME,
  TRAEFIK_DYNAMIC_CONFIG_DIR,
  TRAEFIK_IMAGE,
  buildTraefikServiceConfig,
  resolveTraefikPublishPorts,
} from "../../src/global-services/traefik.ts";

const decodeConfig = async (): Promise<ServiceConfig> => {
  const value = await Effect.runPromise(traefikGlobalService);
  return Schema.decodeUnknownSync(ServiceConfig)(value);
};

const commandText = (config: ServiceConfig): string =>
  typeof config.command === "string" ? config.command : (config.command?.join("\n") ?? "");

describe("traefik global service ServiceConfig", () => {
  test("default export is an Effect producing a valid ServiceConfig", async () => {
    const config = await decodeConfig();
    expect(config.api).toBe(4);
    expect(config.type).toBe("compose");
  });

  test("uses a pinned Traefik v3 image", async () => {
    const config = await decodeConfig();
    expect(config.image).toBe(TRAEFIK_IMAGE);
    expect(TRAEFIK_IMAGE.startsWith("traefik:v3")).toBe(true);
  });

  test("opts out of the per-app source mount", async () => {
    const config = await decodeConfig();
    expect(config.appMount).toBe(false);
  });

  test("publishes rootless-safe loopback ingress endpoints", async () => {
    const config = await decodeConfig();
    const published = (config.endpoints ?? []).filter((endpoint) => endpoint._tag === "published");
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      _tag: "published",
      name: "web",
      protocol: "http",
      port: 80,
      publication: { bindAddress: "127.0.0.1" },
    });
    expect(published[1]).toMatchObject({
      _tag: "published",
      name: "websecure",
      protocol: "https",
      port: 443,
      publication: { bindAddress: "127.0.0.1" },
    });
    expect(config.ports).toEqual([{ protocol: "tcp", target: 8080 }]);
  });

  test("mounts the durable route configuration into the file provider directory", async () => {
    const config = await decodeConfig();
    expect(config.mounts).toEqual([
      {
        type: "bind",
        source: "./proxy-traefik/dynamic",
        target: TRAEFIK_DYNAMIC_CONFIG_DIR,
        readOnly: false,
      },
    ]);
  });

  test("enables the file provider and dashboard via static flags", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain(`--providers.file.directory=${TRAEFIK_DYNAMIC_CONFIG_DIR}`);
    expect(text).toContain("--providers.file.watch=true");
    expect(text).toContain("--api.dashboard=true");
    expect(text).toContain("--entrypoints.web.address=:80");
    expect(text).toContain("--entrypoints.websecure.address=:443");
    expect(text).toContain("--entrypoints.traefik.address=:8080");
    // Routing must NOT depend on the provider-specific Docker provider.
    expect(text).not.toContain("--providers.docker");
  });

  test("routes the dashboard through the file provider on traefik.lndo.site → api@internal", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(TRAEFIK_DASHBOARD_HOSTNAME).toBe("traefik.lndo.site");
    expect(text).toContain("Host(`traefik.lndo.site`)");
    expect(text).toContain("api@internal");
    // The router is materialized into the dynamic config directory at start.
    expect(text).toContain(TRAEFIK_DYNAMIC_CONFIG_DIR);
    expect(text).toContain("exec traefik");
  });

  test("maps host.lando.internal to the host gateway so cross-engine backends can be reached", async () => {
    const config = await decodeConfig();
    expect(config.extra_hosts).toEqual({ "host.lando.internal": "host-gateway" });
  });

  test("adds NET_BIND_SERVICE so privileged loopback ports can be acquired", async () => {
    // Given: the bundled Traefik global ServiceConfig.
    const config = await decodeConfig();

    // When: compose capabilities are read.
    const capabilities = config.cap_add;

    // Then: NET_BIND_SERVICE is present for privileged-port insurance.
    expect(capabilities).toEqual(["NET_BIND_SERVICE"]);
  });
});

describe("buildTraefikServiceConfig", () => {
  test("publishes chosen host ports on loopback ingress endpoints", () => {
    // Given: chosen HTTP 8080 and HTTPS 8443.
    const chosen = { http: 8080, https: 8443 };

    // When: the Traefik ServiceConfig is built from that pair.
    const config = buildTraefikServiceConfig(chosen);

    // Then: endpoints publish 8080/8443 on container 80/443 at 127.0.0.1, not 38080/38443.
    expect(config.endpoints).toEqual([
      {
        _tag: "published",
        name: "web",
        protocol: "http",
        port: 80,
        publication: { bindAddress: "127.0.0.1", hostPort: 8080 },
      },
      {
        _tag: "published",
        name: "websecure",
        protocol: "https",
        port: 443,
        publication: { bindAddress: "127.0.0.1", hostPort: 8443 },
      },
    ]);
    const hostPorts = (config.endpoints ?? []).flatMap((endpoint) =>
      endpoint._tag === "published" ? [endpoint.publication.hostPort] : [],
    );
    expect(hostPorts).not.toContain(38080);
    expect(hostPorts).not.toContain(38443);
  });

  test("publishes last-resort host ports when they are the chosen pair", () => {
    // Given: the chosen pair is the last-resort 38080/38443.
    const chosen = { http: 38080, https: 38443 };

    // When: the Traefik ServiceConfig is built from that pair.
    const config = buildTraefikServiceConfig(chosen);

    // Then: those host ports are present on the published endpoints.
    const hostPorts = (config.endpoints ?? []).flatMap((endpoint) =>
      endpoint._tag === "published" ? [endpoint.publication.hostPort] : [],
    );
    expect(hostPorts).toContain(38080);
    expect(hostPorts).toContain(38443);
  });

  test("keeps the dashboard port expose-only when HTTP publishes on 8080", () => {
    // Given: HTTP 8080 (same number as the dashboard container port).
    const chosen = { http: 8080, https: 8443 };

    // When: the Traefik ServiceConfig is built from that pair.
    const config = buildTraefikServiceConfig(chosen);

    // Then: ports is still dashboard expose-only, with no hostPort on the dashboard.
    expect(config.ports).toEqual([{ protocol: "tcp", target: 8080 }]);
  });
});

describe("resolveTraefikPublishPorts", () => {
  test("defaults to last-resort loopback ports when acquisition state is absent", () => {
    // Given: no acquisition state.
    const state = undefined;

    // When: publish ports are resolved.
    const ports = resolveTraefikPublishPorts(state);

    // Then: last-resort 38080/38443 are chosen.
    expect(ports).toEqual({ http: 38080, https: 38443 });
  });

  test("uses occupied-hop httpPort and httpsPort as publish ports", () => {
    // Given: occupied-hop-like state with 8080/8443.
    const state = { httpPort: 8080, httpsPort: 8443 };

    // When: publish ports are resolved.
    const ports = resolveTraefikPublishPorts(state);

    // Then: those host ports are the publish pair.
    expect(ports).toEqual({ http: 8080, https: 8443 });
  });

  test("uses socket-helper bind ports as publish ports", () => {
    // Given: socket-helper state with public 80/443 and bind 8080/8443.
    const state = {
      httpPort: 80,
      httpsPort: 443,
      bindHttpPort: 8080,
      bindHttpsPort: 8443,
    };

    // When: publish ports are resolved.
    const ports = resolveTraefikPublishPorts(state);

    // Then: the container publishes on the bind ports, not 80/443.
    expect(ports).toEqual({ http: 8080, https: 8443 });
  });

  test("does not publish 80/443 for socket-helper state without bind ports", () => {
    // Given: pre-bind-port socket-helper JSON with public 80/443 only.
    const state = { mode: "socket-helper", httpPort: 80, httpsPort: 443 };

    // When: publish ports are resolved.
    const ports = resolveTraefikPublishPorts(state);

    // Then: Traefik stays on the last-resort hop pair, not 80/443.
    expect(ports).toEqual({ http: 38080, https: 38443 });
  });
});
