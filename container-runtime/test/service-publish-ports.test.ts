import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { DEFAULT_ROUTER_HTTP_PORTS, DEFAULT_ROUTER_HTTPS_PORTS } from "@lando/sdk/schema";
import type { EndpointPlan, PublishedEndpoint } from "@lando/sdk/schema";

import {
  SERVICE_PUBLISH_PORT_MAX,
  SERVICE_PUBLISH_PORT_MIN,
  SERVICE_PUBLISH_RESERVED_PORTS,
  classifyServicePublishHost,
  copyInspectHostPorts,
  inspectHostPortForEndpoint,
  isHostPortBindRejection,
  prepareCreatePublishEndpoints,
  probeUnpinnedServicePublishPorts,
  shouldProbeServicePublishPort,
  type ServicePublishBindOutcome,
  type ServicePublishProbe,
} from "../src/service-publish-ports.ts";

const published = (input: {
  readonly port?: number;
  readonly protocol?: PublishedEndpoint["protocol"];
  readonly bindAddress?: string;
  readonly hostPort?: number;
}): PublishedEndpoint => ({
  _tag: "published",
  port: input.port ?? 8080,
  protocol: input.protocol ?? "http",
  publication: {
    ...(input.bindAddress === undefined ? {} : { bindAddress: input.bindAddress }),
    ...(input.hostPort === undefined ? {} : { hostPort: input.hostPort }),
  },
});

const recordingProbe = (
  outcomes: ReadonlyArray<ServicePublishBindOutcome> | ((port: number, protocol: "tcp" | "udp") => ServicePublishBindOutcome),
): { readonly probeBind: ServicePublishProbe; readonly calls: Array<{ host: string; port: number; protocol: "tcp" | "udp" }> } => {
  const calls: Array<{ host: string; port: number; protocol: "tcp" | "udp" }> = [];
  let index = 0;
  return {
    calls,
    probeBind: (host, port, protocol) => {
      calls.push({ host, port, protocol });
      const outcome =
        typeof outcomes === "function" ? outcomes(port, protocol) : (outcomes[index++] ?? { kind: "success" });
      return Effect.succeed(outcome);
    },
  };
};

describe("service-publish port band", () => {
  test("stays off router ladders, helper backends, win32 extras, and the host ephemeral range", () => {
    const reserved = new Set<number>([
      ...DEFAULT_ROUTER_HTTP_PORTS,
      ...DEFAULT_ROUTER_HTTPS_PORTS,
      38_080, 48_080, 58_080, 38_443, 48_443, 58_443, 48_081, 58_081, 48_082, 58_082, 48_444, 58_444, 48_445,
      58_445,
    ]);
    expect(SERVICE_PUBLISH_PORT_MIN).toBe(30_000);
    expect(SERVICE_PUBLISH_PORT_MAX).toBe(32_767);
    expect(SERVICE_PUBLISH_PORT_MAX).toBeLessThan(32_768);
    for (let port = SERVICE_PUBLISH_PORT_MIN; port <= SERVICE_PUBLISH_PORT_MAX; port += 1) {
      expect(reserved.has(port)).toBe(false);
      expect(SERVICE_PUBLISH_RESERVED_PORTS.has(port)).toBe(false);
    }
  });
});

describe("classifyServicePublishHost", () => {
  test("treats a remote URL as a skip target", () => {
    expect(classifyServicePublishHost({ platform: "linux", daemonUrl: "tcp://127.0.0.1:2375" })).toEqual({
      kind: "remote-url",
    });
    expect(shouldProbeServicePublishPort({ kind: "remote-url" })).toBe(false);
  });

  test("treats VM-mediated Docker as a skip target", () => {
    expect(classifyServicePublishHost({ platform: "darwin", daemonUrl: "/var/run/docker.sock" })).toEqual({
      kind: "vm-mediated-docker",
    });
    expect(
      classifyServicePublishHost({
        platform: "linux",
        daemonUrl: "/home/user/.docker/desktop/docker.sock",
      }),
    ).toEqual({ kind: "vm-mediated-docker" });
    expect(shouldProbeServicePublishPort({ kind: "vm-mediated-docker" })).toBe(false);
  });

  test("treats win32 guest as a skip target", () => {
    expect(classifyServicePublishHost({ platform: "win32", daemonUrl: "npipe://./pipe/docker_engine" })).toEqual({
      kind: "win32-guest",
    });
    expect(shouldProbeServicePublishPort({ kind: "win32-guest" })).toBe(false);
  });

  test("probes only when the daemon is this host", () => {
    expect(classifyServicePublishHost({ platform: "linux", daemonUrl: "/run/user/1000/podman/podman.sock" })).toEqual(
      { kind: "local" },
    );
    expect(shouldProbeServicePublishPort({ kind: "local" })).toBe(true);
  });
});

describe("copyInspectHostPorts", () => {
  const inspect = {
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "31234" }] } },
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "31234" }] } },
  };

  test("copies inspect HostPort onto an unpinned local endpoint copy", () => {
    const endpoints: ReadonlyArray<EndpointPlan> = [published({})];
    const copied = copyInspectHostPorts(endpoints, inspect);
    expect(copied[0]).toMatchObject({ publication: { hostPort: 31_234 } });
    expect(endpoints[0]?.publication.hostPort).toBeUndefined();
  });

  test("leaves an explicit hostPort untouched", () => {
    const endpoints: ReadonlyArray<EndpointPlan> = [published({ hostPort: 18_080 })];
    expect(copyInspectHostPorts(endpoints, inspect)).toEqual(endpoints);
  });

  test("reads HostConfig.PortBindings when NetworkSettings.Ports is absent", () => {
    const endpoint = published({ port: 80, protocol: "tcp" });
    expect(
      inspectHostPortForEndpoint(
        { HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "30111" }] } } },
        endpoint,
      ),
    ).toBe(30_111);
  });
});

describe("probeUnpinnedServicePublishPorts", () => {
  test("first create probes the named service-publish band", async () => {
    const { probeBind, calls } = recordingProbe([{ kind: "success" }]);
    const assigned = await Effect.runPromise(probeUnpinnedServicePublishPorts([published({})], { probeBind }));
    expect(calls[0]).toEqual({ host: "127.0.0.1", port: SERVICE_PUBLISH_PORT_MIN, protocol: "tcp" });
    expect(assigned[0]).toMatchObject({ publication: { hostPort: SERVICE_PUBLISH_PORT_MIN } });
  });

  test("probes publication.bindAddress and assigns unique ports", async () => {
    const { probeBind, calls } = recordingProbe([{ kind: "success" }, { kind: "success" }]);
    const assigned = await Effect.runPromise(
      probeUnpinnedServicePublishPorts(
        [published({ bindAddress: "0.0.0.0" }), published({ port: 443, protocol: "https" })],
        { probeBind },
      ),
    );
    expect(calls.map((call) => call.host)).toEqual(["0.0.0.0", "127.0.0.1"]);
    expect(calls.map((call) => call.port)).toEqual([SERVICE_PUBLISH_PORT_MIN, SERVICE_PUBLISH_PORT_MIN + 1]);
    expect(assigned.map((endpoint) => (endpoint._tag === "published" ? endpoint.publication.hostPort : undefined))).toEqual([
      SERVICE_PUBLISH_PORT_MIN,
      SERVICE_PUBLISH_PORT_MIN + 1,
    ]);
  });

  test("EACCES does not walk the band", async () => {
    const { probeBind, calls } = recordingProbe([{ kind: "EACCES", code: "EACCES" }]);
    const assigned = await Effect.runPromise(probeUnpinnedServicePublishPorts([published({})], { probeBind }));
    expect(calls).toEqual([{ host: "127.0.0.1", port: SERVICE_PUBLISH_PORT_MIN, protocol: "tcp" }]);
    expect(assigned[0]).toMatchObject({ publication: { hostPort: SERVICE_PUBLISH_PORT_MIN } });
  });

  test("a TCP probe does not satisfy udp", async () => {
    const { probeBind, calls } = recordingProbe((port, protocol) => {
      if (protocol === "tcp") return { kind: "success" };
      if (port === SERVICE_PUBLISH_PORT_MIN) return { kind: "EADDRINUSE", code: "EADDRINUSE" };
      return { kind: "success" };
    });
    const assigned = await Effect.runPromise(
      probeUnpinnedServicePublishPorts([published({ protocol: "udp" })], { probeBind }),
    );
    expect(calls.every((call) => call.protocol === "udp")).toBe(true);
    expect(calls[0]?.port).toBe(SERVICE_PUBLISH_PORT_MIN);
    expect(assigned[0]).toMatchObject({ publication: { hostPort: SERVICE_PUBLISH_PORT_MIN + 1 } });
  });
});

describe("prepareCreatePublishEndpoints", () => {
  test("skips the probe for remote URL, VM-mediated Docker, and win32 guest", async () => {
    const { probeBind, calls } = recordingProbe([{ kind: "success" }]);
    for (const kind of ["remote-url", "vm-mediated-docker", "win32-guest"] as const) {
      const assigned = await Effect.runPromise(
        prepareCreatePublishEndpoints({
          endpoints: [published({})],
          copyInspectHostPort: false,
          host: { kind },
          probeBind,
        }),
      );
      expect(assigned[0]).toMatchObject({ publication: {} });
    }
    expect(calls).toEqual([]);
  });
});

describe("isHostPortBindRejection", () => {
  test("recognizes a daemon address-in-use create rejection", () => {
    expect(isHostPortBindRejection({ status: 500, body: "address already in use" })).toBe(true);
    expect(isHostPortBindRejection({ status: 500, body: "Bind for 127.0.0.1:30000 failed: port is already allocated" })).toBe(
      true,
    );
    expect(isHostPortBindRejection({ status: 500, body: "no such image" })).toBe(false);
  });
});
