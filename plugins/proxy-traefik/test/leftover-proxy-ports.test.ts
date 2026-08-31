import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { HostPlatform } from "@lando/sdk/schema";

import {
  type LoopbackPortReaders,
  type LoopbackPortSnapshot,
  makeLeftoverProxyPortsCheck,
} from "../src/leftover-proxy-ports.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../src/ports.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;

const snapshot = (
  port: number,
  fields: Omit<LoopbackPortSnapshot, "port" | "host">,
): LoopbackPortSnapshot => ({
  port,
  host: LOOPBACK_HOST,
  ...fields,
});

const free = (port: number): LoopbackPortSnapshot => snapshot(port, { listening: false });

const leftover = (port: number): LoopbackPortSnapshot =>
  snapshot(port, { listening: true, comm: "rootlessport", kind: "leftover-rootlessport" });

const readersFor = (ports: Readonly<Record<number, LoopbackPortSnapshot>>): LoopbackPortReaders => ({
  readPort: async (port) => ports[port] ?? free(port),
});

const runCheck = (
  readers: LoopbackPortReaders,
  platform: HostPlatform = "linux",
  ports?: { readonly httpPort: number; readonly httpsPort: number },
) =>
  Effect.runPromise(
    makeLeftoverProxyPortsCheck(readers, ports).run({
      providerId: "lando",
      platform,
      env: {},
      userDataRoot: undefined,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

const joinedSolutions = (
  solutions: ReadonlyArray<{ readonly description: string; readonly command?: string | undefined }>,
) => solutions.map((solution) => `${solution.description} ${solution.command ?? ""}`).join(" ");

describe("makeLeftoverProxyPortsCheck", () => {
  test("warns when HTTP loopback is held by leftover rootlessport", async () => {
    // Given: 127.0.0.1:TRAEFIK_HTTP_PORT is listening as leftover rootlessport.
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: leftover(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: free(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: one warn names the leftover HTTP port and offers three remediations.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      name: "proxy-loopback-ports",
      status: "warn",
      severity: "warn",
    });
    expect(reports[0]?.context.host).toBe(LOOPBACK_HOST);
    expect(reports[0]?.context.ports).toContain(String(TRAEFIK_HTTP_PORT));
    expect(reports[0]?.solutions).toHaveLength(3);
    const remediation = joinedSolutions(reports[0]?.solutions ?? []);
    expect(remediation).toContain("lando global:stop");
    expect(remediation).toContain("rootlessport");
    expect(remediation).toContain("lando setup");
  });

  test("collapses leftover HTTP and TLS ports into one report", async () => {
    // Given: both Traefik loopback ports are leftover rootlessport holders.
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: leftover(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: leftover(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: a single report lists both ports in HTTP-then-TLS order.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context.ports).toBe(`${TRAEFIK_HTTP_PORT},${TRAEFIK_HTTPS_PORT}`);
  });

  test("reports leftover TLS without listing the free HTTP port", async () => {
    // Given: only the TLS loopback port is leftover rootlessport.
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: free(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: leftover(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: the report names only the TLS port.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context.ports).toBe(String(TRAEFIK_HTTPS_PORT));
    expect(reports[0]?.context.ports).not.toContain(String(TRAEFIK_HTTP_PORT));
  });

  test("returns no reports when both loopback ports are free", async () => {
    // Given: neither Traefik loopback port is listening.
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: free(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: free(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: leftover-port warning is absent.
    expect(reports).toEqual([]);
  });

  test("returns no reports when a foreign process holds the ports", async () => {
    // Given: nginx is listening on both Traefik loopback ports.
    const foreign = (port: number): LoopbackPortSnapshot =>
      snapshot(port, { listening: true, comm: "nginx", kind: "foreign" });
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: foreign(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: foreign(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: a foreign holder is not a leftover-proxy warning.
    expect(reports).toEqual([]);
  });

  test("returns no reports when a healthy proxy holds the ports", async () => {
    // Given: a healthy proxy is listening even though comm is rootlessport.
    const healthy = (port: number): LoopbackPortSnapshot =>
      snapshot(port, { listening: true, comm: "rootlessport", kind: "healthy-proxy" });
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: healthy(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: healthy(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: a classified healthy proxy is not leftover.
    expect(reports).toEqual([]);
  });

  test("returns no reports when the holder is unknown", async () => {
    // Given: both ports are listening with an unknown holder.
    const unknown = (port: number): LoopbackPortSnapshot =>
      snapshot(port, { listening: true, kind: "unknown" });
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: unknown(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: unknown(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: an unknown holder never creates a leftover warning.
    expect(reports).toEqual([]);
  });

  test("still reports leftover ports on darwin", async () => {
    // Given: leftover rootlessport on darwin loopback.
    const readers = readersFor({
      [TRAEFIK_HTTP_PORT]: leftover(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: free(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs on darwin.
    const reports = await runCheck(readers, "darwin");

    // Then: platform does not suppress an injected leftover.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.name).toBe("proxy-loopback-ports");
    expect(reports[0]?.context.ports).toContain(String(TRAEFIK_HTTP_PORT));
  });

  test("exposes a always-relevant proxy-loopback-ports contribution", () => {
    // Given: leftover-port readers for contribution metadata.
    const readers = readersFor({});

    // When: the doctor contribution is constructed.
    const check = makeLeftoverProxyPortsCheck(readers);

    // Then: the contribution id is fixed and relevant is unset.
    expect(check.id).toBe("proxy-loopback-ports");
    expect(check.relevant).toBeUndefined();
  });

  test("warns when leftover rootlessport holds the persisted HTTP port", async () => {
    // Given: 127.0.0.1:8080 is leftover rootlessport and last-fallback 38080 is also leftover.
    const chosen = { httpPort: 8080, httpsPort: 8443 } as const;
    const readers = readersFor({
      [chosen.httpPort]: leftover(chosen.httpPort),
      [chosen.httpsPort]: free(chosen.httpsPort),
      [TRAEFIK_HTTP_PORT]: leftover(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: free(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs against the persisted pair.
    const reports = await runCheck(readers, "linux", chosen);

    // Then: one warn names only the persisted HTTP port.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context.ports).toBe(String(chosen.httpPort));
    expect(reports[0]?.context.ports).not.toContain(String(TRAEFIK_HTTP_PORT));
  });

  test("collapses leftover persisted HTTP and TLS ports into one report", async () => {
    // Given: both persisted Traefik ports are leftover rootlessport holders.
    const chosen = { httpPort: 8080, httpsPort: 8443 } as const;
    const readers = readersFor({
      [chosen.httpPort]: leftover(chosen.httpPort),
      [chosen.httpsPort]: leftover(chosen.httpsPort),
    });

    // When: the doctor contribution runs against the persisted pair.
    const reports = await runCheck(readers, "linux", chosen);

    // Then: a single report lists both persisted ports in HTTP-then-TLS order.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context.ports).toBe(`${chosen.httpPort},${chosen.httpsPort}`);
  });

  test("does not warn when leftover is only on last-fallback ports", async () => {
    // Given: leftover rootlessport on 38080/38443 while Traefik publishes 8080/8443.
    const chosen = { httpPort: 8080, httpsPort: 8443 } as const;
    const readers = readersFor({
      [chosen.httpPort]: free(chosen.httpPort),
      [chosen.httpsPort]: free(chosen.httpsPort),
      [TRAEFIK_HTTP_PORT]: leftover(TRAEFIK_HTTP_PORT),
      [TRAEFIK_HTTPS_PORT]: leftover(TRAEFIK_HTTPS_PORT),
    });

    // When: the doctor contribution runs against the persisted pair.
    const reports = await runCheck(readers, "linux", chosen);

    // Then: last-fallback leftover is not this check.
    expect(reports).toEqual([]);
  });

  test("does not warn when a healthy Traefik answers on persisted ports", async () => {
    // Given: another instance's healthy Traefik is listening via rootlessport on 8080/8443.
    const chosen = { httpPort: 8080, httpsPort: 8443 } as const;
    const healthy = (port: number): LoopbackPortSnapshot =>
      snapshot(port, { listening: true, comm: "rootlessport", kind: "healthy-proxy" });
    const readers = readersFor({
      [chosen.httpPort]: healthy(chosen.httpPort),
      [chosen.httpsPort]: healthy(chosen.httpsPort),
    });

    // When: the doctor contribution runs against the persisted pair.
    const reports = await runCheck(readers, "linux", chosen);

    // Then: a classified healthy proxy is not leftover rootlessport.
    expect(reports).toEqual([]);
  });

  test("does not warn when a foreign or unknown holder occupies persisted ports", async () => {
    // Given: nginx and an unknown holder occupy the persisted pair.
    const chosen = { httpPort: 8080, httpsPort: 8443 } as const;
    const foreign = snapshot(chosen.httpPort, { listening: true, comm: "nginx", kind: "foreign" });
    const unknown = snapshot(chosen.httpsPort, { listening: true, kind: "unknown" });
    const readers = readersFor({
      [chosen.httpPort]: foreign,
      [chosen.httpsPort]: unknown,
    });

    // When: the doctor contribution runs against the persisted pair.
    const reports = await runCheck(readers, "linux", chosen);

    // Then: foreign and unknown holders are not leftover-proxy warnings.
    expect(reports).toEqual([]);
  });
});
