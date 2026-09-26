import { describe, expect, test } from "bun:test";

import {
  formatOccupiedPortWarning,
  occupiedHopNotices,
  systemdServiceFromCgroup,
  warningFromHolder,
} from "../src/occupied-port-warning.ts";

describe("systemdServiceFromCgroup", () => {
  test("extracts a system-slice unit name", () => {
    // Given: a unified cgroup path for caddy.service.
    // When: systemdServiceFromCgroup parses it.
    const unit = systemdServiceFromCgroup("0::/system.slice/caddy.service\n");
    // Then: the unit name is caddy.
    expect(unit).toBe("caddy");
  });

  test("skips docker.service", () => {
    // Given: a cgroup for docker.service.
    // When: systemdServiceFromCgroup parses it.
    const unit = systemdServiceFromCgroup("0::/system.slice/docker.service\n");
    // Then: docker is not treated as a stoppable occupant.
    expect(unit).toBeUndefined();
  });

  test("returns undefined when no unit is present", () => {
    // Given: a session scope cgroup.
    // When: systemdServiceFromCgroup parses it.
    const unit = systemdServiceFromCgroup("0::/user.slice/user-1000.slice/session-2.scope\n");
    // Then: no service name is returned.
    expect(unit).toBeUndefined();
  });
});

describe("formatOccupiedPortWarning", () => {
  test("names a known service and an available alternate URL", () => {
    // Given: Caddy occupies port 80 and Lando hops to 8080.
    // When: formatOccupiedPortWarning runs.
    const body = formatOccupiedPortWarning({
      preferred: 80,
      chosen: 8080,
      kind: "caddy",
    });
    // Then: the warning names Caddy, the fallback port, the usable alternate URL.
    expect(body).toContain("80");
    expect(body).toContain("8080");
    expect(body).toContain("Caddy");
    expect(body).toContain("alternate URL is available");
    expect(body).toContain("lando info");
  });

  test("names an unknown process while preserving the alternate URL", () => {
    // Given: an unrecognized process holds the preferred port.
    // When: formatOccupiedPortWarning runs.
    const body = formatOccupiedPortWarning({
      preferred: 80,
      chosen: 8080,
      kind: "unknown",
      identity: { comm: "python3", pid: 4242 },
    });
    // Then: the warning names the process and pid, not a service command.
    expect(body).toContain('process "python3" (pid 4242)');
    expect(body).toContain("8080");
    expect(body).toContain("alternate URL is available");
    expect(body).not.toContain("systemctl");
  });

  test("uses a generic warning when the occupant is unknown", () => {
    // Given: the preferred port is unavailable with no holder identity.
    // When: formatOccupiedPortWarning runs.
    const body = formatOccupiedPortWarning({
      preferred: 443,
      chosen: 8443,
      kind: "unknown",
    });
    // Then: the warning is generic and still names the fallback.
    expect(body).toContain("443");
    expect(body).toContain("8443");
    expect(body).toContain("alternate URL is available");
    expect(body).not.toContain("process");
  });

  test("names a systemd unit without instructing its removal", () => {
    // Given: an unknown occupant with a systemd unit.
    // When: formatOccupiedPortWarning runs.
    const body = formatOccupiedPortWarning({
      preferred: 80,
      chosen: 8080,
      kind: "unknown",
      systemdUnit: "my-proxy",
    });
    // Then: the warning names that unit and keeps the alternate URL available.
    expect(body).toContain("my-proxy.service");
    expect(body).toContain("alternate URL is available");
  });
});

describe("occupiedHopNotices", () => {
  test("emits one notice per hopped protocol", () => {
    // Given: both preferred ports hop to fallbacks.
    // When: occupiedHopNotices runs.
    const notices = occupiedHopNotices({
      preferredHttp: 80,
      preferredHttps: 443,
      httpPort: 8080,
      httpsPort: 8443,
      http: { holder: "caddy" },
      https: { holder: "caddy" },
    });
    // Then: both fallbacks are named.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("8080");
    expect(notices[1]).toContain("8443");
  });

  test("omits a protocol that stayed on the preferred port", () => {
    // Given: only HTTP hopped.
    // When: occupiedHopNotices runs.
    const notices = occupiedHopNotices({
      preferredHttp: 80,
      preferredHttps: 443,
      httpPort: 8080,
      httpsPort: 443,
      http: { holder: "nginx" },
      https: {},
    });
    // Then: only the HTTP notice is present.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("80");
    expect(notices[0]).not.toContain("443");
  });
});

describe("warningFromHolder", () => {
  test("classifies nginx from comm", () => {
    // Given: holder comm is nginx.
    // When: warningFromHolder runs.
    const body = warningFromHolder(80, 8080, { holder: "nginx" });
    // Then: the known-service nginx identity is shown with the alternate URL.
    expect(body).toContain("nginx");
    expect(body).toContain("alternate URL is available");
  });
});
