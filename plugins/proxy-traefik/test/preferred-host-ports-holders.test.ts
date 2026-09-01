import { describe, expect, test } from "bun:test";

import {
  OCCUPANCY_HOLDER_KINDS,
  type OccupancyHolderKind,
  classifyOccupancyHolder,
  solutionsForOccupancyHolder,
} from "../src/preferred-host-ports-holders.ts";

describe("OCCUPANCY_HOLDER_KINDS", () => {
  test("lists every holder kind in stable order", () => {
    // Given: the exported kinds tuple.
    // When: reading OCCUPANCY_HOLDER_KINDS.
    // Then: every OccupancyHolderKind is present once.
    expect([...OCCUPANCY_HOLDER_KINDS]).toEqual([
      "ddev",
      "lando3",
      "docksal",
      "apache",
      "nginx",
      "caddy",
      "iis",
      "unknown",
    ]);
  });
});

describe("classifyOccupancyHolder", () => {
  test("classifies ddev-router comm as ddev", () => {
    // Given: process comm is ddev-router.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "ddev-router" });
    // Then: kind is ddev.
    expect(kind).toBe("ddev");
  });

  test("classifies ddev comm as ddev", () => {
    // Given: process comm is ddev.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "ddev" });
    // Then: kind is ddev.
    expect(kind).toBe("ddev");
  });

  test("classifies traefik comm with ddev in cmdline as ddev", () => {
    // Given: traefik process whose cmdline mentions ddev.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({
      comm: "traefik",
      cmdline: "/usr/local/bin/traefik --config=/var/lib/ddev/traefik",
    });
    // Then: kind is ddev.
    expect(kind).toBe("ddev");
  });

  test("classifies landoproxyhyperion as lando3", () => {
    // Given: Lando v3 proxy process name.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "landoproxyhyperion" });
    // Then: kind is lando3.
    expect(kind).toBe("lando3");
  });

  test("classifies docksal-vhost-proxy as docksal", () => {
    // Given: Docksal vhost proxy process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "docksal-vhost-proxy" });
    // Then: kind is docksal.
    expect(kind).toBe("docksal");
  });

  test("classifies apache2 as apache", () => {
    // Given: apache2 process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "apache2" });
    // Then: kind is apache.
    expect(kind).toBe("apache");
  });

  test("classifies httpd as apache", () => {
    // Given: httpd process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "httpd" });
    // Then: kind is apache.
    expect(kind).toBe("apache");
  });

  test("classifies nginx as nginx", () => {
    // Given: nginx process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "nginx" });
    // Then: kind is nginx.
    expect(kind).toBe("nginx");
  });

  test("classifies caddy as caddy", () => {
    // Given: caddy process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "caddy" });
    // Then: kind is caddy.
    expect(kind).toBe("caddy");
  });

  test("classifies w3wp as iis", () => {
    // Given: IIS worker process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "w3wp" });
    // Then: kind is iis.
    expect(kind).toBe("iis");
  });

  test("classifies iis as iis", () => {
    // Given: iis process name.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "iis" });
    // Then: kind is iis.
    expect(kind).toBe("iis");
  });

  test("classifies http.sys as iis", () => {
    // Given: HTTP.sys binding identity.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "http.sys" });
    // Then: kind is iis.
    expect(kind).toBe("iis");
  });

  test("classifies bare traefik as unknown", () => {
    // Given: bare traefik with no ddev marker.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "traefik" });
    // Then: kind is unknown (not Lando-owned).
    expect(kind).toBe("unknown");
  });

  test("classifies bare lando as unknown", () => {
    // Given: bare lando process name without landoproxy markers.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "lando" });
    // Then: kind is unknown.
    expect(kind).toBe("unknown");
  });

  test("classifies docker-proxy as unknown", () => {
    // Given: docker-proxy process.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "docker-proxy" });
    // Then: kind is unknown.
    expect(kind).toBe("unknown");
  });

  test("classifies unrecognized process as unknown", () => {
    // Given: unknown foreign listener with comm and pid.
    // When: classifyOccupancyHolder runs.
    const kind = classifyOccupancyHolder({ comm: "some-app", cmdline: "--listen=80" });
    // Then: kind is unknown.
    expect(kind).toBe("unknown");
  });
});

describe("solutionsForOccupancyHolder", () => {
  test("ddev solutions include poweroff, port move, and restart", () => {
    // Given: holder kind ddev.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("ddev");
    // Then: poweroff, global port move, and restart remediations are present.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "ddev poweroff")).toBe(true);
    expect(
      solutions.some(
        (s) => s.command === "ddev config global --router-http-port=8080 --router-https-port=8443",
      ),
    ).toBe(true);
    expect(solutions.some((s) => s.command === "ddev restart" || /ddev restart/i.test(s.description))).toBe(
      true,
    );
  });

  test("lando3 solutions include lando poweroff", () => {
    // Given: holder kind lando3.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("lando3");
    // Then: v3 poweroff command is offered.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "lando poweroff")).toBe(true);
  });

  test("docksal solutions include fin stop", () => {
    // Given: holder kind docksal.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("docksal");
    // Then: fin stop is offered.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "fin stop")).toBe(true);
  });

  test("apache solutions describe stopping the system Apache service", () => {
    // Given: holder kind apache.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("apache");
    // Then: remediation mentions stopping Apache.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "sudo systemctl stop apache2")).toBe(true);
  });

  test("nginx solutions describe stopping the system nginx service", () => {
    // Given: holder kind nginx.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("nginx");
    // Then: remediation mentions stopping nginx.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "sudo systemctl stop nginx")).toBe(true);
  });

  test("caddy solutions describe stopping Caddy", () => {
    // Given: holder kind caddy.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("caddy");
    // Then: remediation mentions stopping Caddy.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => s.command === "sudo systemctl stop caddy")).toBe(true);
  });

  test("iis solutions describe stopping IIS or HTTP.sys binding", () => {
    // Given: holder kind iis.
    // When: solutionsForOccupancyHolder is called.
    const solutions = solutionsForOccupancyHolder("iis");
    // Then: remediation mentions IIS or HTTP.sys on 80/443.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.some((s) => /iis|http\.sys/i.test(s.description))).toBe(true);
  });

  test("unknown solutions name comm, pid, and router ports when provided", () => {
    // Given: unknown holder with comm and pid identity.
    // When: solutionsForOccupancyHolder is called with identity.
    const solutions = solutionsForOccupancyHolder("unknown", { comm: "some-app", pid: 4242 });
    // Then: descriptions name both identity fields and router.httpPort/httpsPort.
    expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    expect(solutions.length).toBeGreaterThan(0);
    const joined = solutions.map((s) => s.description).join(" ");
    expect(joined).toContain("some-app");
    expect(joined).toContain("4242");
    expect(joined).toMatch(/router\.httpPort/);
    expect(joined).toMatch(/httpsPort/);
  });

  test("every OccupancyHolderKind has at least one solution", () => {
    // Given: every exported holder kind.
    // When: solutionsForOccupancyHolder is called for each.
    const kinds: ReadonlyArray<OccupancyHolderKind> = OCCUPANCY_HOLDER_KINDS;
    // Then: each kind yields one or more manual solutions.
    for (const kind of kinds) {
      const solutions = solutionsForOccupancyHolder(kind);
      expect(solutions.length).toBeGreaterThan(0);
      expect(solutions.every((s) => s.kind === "manual")).toBe(true);
    }
  });
});
