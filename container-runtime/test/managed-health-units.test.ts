import { describe, expect, test } from "bun:test";

import {
  type ManagedHealthTimer,
  managedHealthRunKey,
  managedHealthTimerArgv,
  managedHealthUnitName,
  managedHealthUnitPrefix,
  parseManagedHealthUnits,
} from "../src/podman/managed-health-units.ts";

const id = "a".repeat(64);
const prefix = managedHealthUnitPrefix("/run/user/1000/lando-0123456789abcdef");

const timer = (overrides: Partial<ManagedHealthTimer> = {}): ManagedHealthTimer => ({
  systemdRun: "/usr/bin/systemd-run",
  unit: managedHealthUnitName(prefix, managedHealthRunKey(id, "2026-11-23T11:03:09.582703484-06:00"), "main"),
  firstMs: 30_000,
  cadenceMs: 30_000,
  timeoutSeconds: 5,
  runtimeBinDir: "/home/u/a b$c%d/runtime/bin",
  socketPath: "/home/u/a b$c%d/runtime/run/podman.sock",
  runtimeConfigDir: "/home/u/a b$c%d/runtime/config",
  containerId: id,
  ...overrides,
});

const execStart = (argv: ReadonlyArray<string>) => argv.slice(argv.indexOf("--") + 1);

describe("native health unit names", () => {
  test("share the private runtime dir's digest and change with every container start", () => {
    // Given two starts of one container, the second a restart within the same second
    const first = managedHealthRunKey(id, "2026-11-23T11:03:09.100000000Z");
    const second = managedHealthRunKey(id, "2026-11-23T11:03:09.900000000Z");
    // Then the keys differ and the prefix scopes the units to one runtime
    expect(prefix).toBe("lando-0123456789abcdef-hc-");
    expect(first).not.toBe(second);
    expect(first.startsWith(`${id}-`)).toBe(true);
  });

  test("round-trip through list-units output with their role, kind and activity", () => {
    // Given a listing with a failed-unit bullet, another runtime's unit and an unrelated unit
    const key = managedHealthRunKey(id, "2026-11-23T11:03:09Z");
    const output = [
      `${managedHealthUnitName(prefix, key, "main")}.timer loaded active waiting Lando native healthcheck`,
      `● ${managedHealthUnitName(prefix, key, "start")}.service loaded failed failed Lando native healthcheck`,
      `${managedHealthUnitName(prefix, key, "start")}.timer loaded inactive dead Lando native healthcheck`,
      `lando-ffffffffffffffff-hc-${key}-main.timer loaded active waiting Lando native healthcheck`,
      "user.slice loaded active active User Slice",
    ].join("\n");
    // When / Then
    expect(parseManagedHealthUnits(prefix, output)).toEqual([
      { key, role: "main", kind: "timer", active: true },
      { key, role: "start", kind: "service", active: false },
      { key, role: "start", kind: "timer", active: false },
    ]);
  });
});

describe("managedHealthTimerArgv", () => {
  test("keeps data-root bytes out of ExecStart and never expands them", () => {
    // Given a data root with a space, `$` and `%`
    const argv = managedHealthTimerArgv(timer());
    // Then ExecStart is fixed text plus the container id
    expect(execStart(argv)).toEqual([
      "/usr/bin/env",
      "podman",
      "--remote",
      "healthcheck",
      "run",
      "--ignore-result",
      id,
    ]);
    expect(argv.some((arg) => arg.startsWith("--expand-environment"))).toBe(false);
    // And the paths reach the service only through its environment
    expect(argv).toContain("--setenv=PATH=/home/u/a b$c%d/runtime/bin");
    expect(argv).toContain("--setenv=CONTAINERS_CONF=/home/u/a b$c%d/runtime/config/containers.conf");
    expect(argv).toContain("--setenv=CONTAINER_HOST=unix:///home/u/a%20b%24c%25d/runtime/run/podman.sock");
  });

  test("drops the user's D-Bus and Podman redirects but keeps the socket it sets", () => {
    const unset = managedHealthTimerArgv(timer()).find((arg) => arg.startsWith("UnsetEnvironment="));
    const names = unset?.slice("UnsetEnvironment=".length).split(" ") ?? [];
    expect(names).toContain("DBUS_SESSION_BUS_ADDRESS");
    expect(names).toContain("CONTAINER_CONNECTION");
    expect(names).not.toContain("CONTAINER_HOST");
  });

  test("binds to the service scope and orders the handoff only when asked", () => {
    // Given a main timer with no scope or start phase
    const plain = managedHealthTimerArgv(timer());
    expect(
      plain.some((arg) => arg.includes("BindsTo=") || arg.includes("After=") || arg.startsWith("Conflicts=")),
    ).toBe(false);
    // When it binds to a scope and takes over from a start-phase unit
    const handoff = managedHealthTimerArgv(timer({ scope: "run-p1-i2.scope", takesOverFrom: "x-start" }));
    // Then the timer stops with the scope and waits for a start-phase run in progress
    expect(handoff).toContain("--timer-property=BindsTo=run-p1-i2.scope");
    expect(handoff).toContain("--timer-property=After=run-p1-i2.scope");
    expect(handoff).toContain("Conflicts=x-start.timer");
    expect(handoff).toContain("After=x-start.service");
    expect(handoff).toContain("Type=oneshot");
  });

  test.each([
    [50, "10ms"],
    [2_000, "200ms"],
    [30_000, "1000ms"],
  ])("gives a %pms cadence %s of timer slack", (cadenceMs, accuracy) => {
    expect(managedHealthTimerArgv(timer({ cadenceMs }))).toContain(
      `--timer-property=AccuracySec=${accuracy}`,
    );
  });
});
