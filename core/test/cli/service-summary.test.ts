import { describe, expect, test } from "bun:test";
import type { StartedService } from "@lando/sdk/schema";
import { scopedConnectionText } from "../../src/cli/commands/connection-summary";
import {
  INFO_STATUS_TONES,
  SCRATCH_STATUS_TONES,
  START_STATUS_TONES,
  joinServiceRows,
  lifecycleLine,
  serviceRowsText,
  serviceStateRow,
  summaryToneFromTable,
  teardownLine,
  unchangedLine,
  volumesTrailer,
} from "../../src/cli/commands/service-summary";
import { connections } from "./connection-fixtures";

describe("service summary", () => {
  test("renders empty lifecycle rows without a separator", () => {
    // Given / When
    const rows = serviceRowsText([]);
    // Then
    expect(rows).toBe("");
    expect(lifecycleLine("ready", "app", rows)).toBe("ready: app");
  });

  test("renders lifecycle rows in supplied order", () => {
    // Given
    const services: readonly StartedService[] = [
      {
        name: "web",
        state: "running",
        connections: [...connections(["https://app.test"]), ...connections(["http://web:3000"], "app")],
      },
      { name: "db", state: "stopped", connections: [] },
    ];
    // When
    const line = lifecycleLine("rebuilt", "app", serviceRowsText(services));
    // Then
    expect(line).toBe(
      "rebuilt: app - web (running) Host: https://app.test App Network: http://web:3000; db (stopped) no endpoints",
    );
  });

  test("renders an empty teardown with no services", () => {
    // Given / When
    const line = teardownLine("stopped", "app", []);
    // Then
    expect(line).toBe("stopped: app - no services");
  });

  test("renders teardown names in supplied order with a volume trailer", () => {
    // Given / When
    const line = teardownLine("destroyed", "app", ["a", "b"], "volumes removed");
    // Then
    expect(line).toBe("destroyed: app - a, b (volumes removed)");
  });

  test("renders unchanged teardown independently of volume intent", () => {
    // Given / When
    const line = unchangedLine("app");
    // Then
    expect(line).toBe("unchanged: app - no services");
  });

  test.each([
    [true, "volumes removed"],
    [false, "volumes preserved"],
  ] as const)("renders volume removal %s", (removed, expected) => {
    // Given / When
    const trailer = volumesTrailer(removed);
    // Then
    expect(trailer).toBe(expected);
  });
  test.each([
    ["running", "ok", "ok", "info"],
    ["ready", "ok", "ok", "info"],
    ["healthy", "ok", "ok", "info"],
    ["starting", "pending", "pending", "info"],
    ["stopped", "skipped", "skipped", "info"],
    ["unhealthy", "error", "error", "info"],
    ["error", "error", "error", "info"],
    ["failed", "error", "info", "info"],
    ["attached", "warn", "info", "ok"],
    ["detached", "warn", "info", "skipped"],
    ["orphan", "warn", "info", "error"],
    ["unknown", "info", "info", "info"],
    ["constructor", "warn", "info", "info"],
  ] as const)("maps %s for each status domain", (status, start, info, scratch) => {
    // Given the domain-specific tables and their existing fallbacks.
    const tones = [
      summaryToneFromTable(START_STATUS_TONES, "warn"),
      summaryToneFromTable(INFO_STATUS_TONES, "info"),
      summaryToneFromTable(SCRATCH_STATUS_TONES, "info"),
    ];
    // When mapping one status across the domains.
    const result = tones.map((tone) => tone(status));
    // Then domain differences and unknown fallbacks survive.
    expect(result).toEqual([start, info, scratch]);
  });

  test.each([
    [[], ""],
    [["tcp://db:3306"], "tcp://db:3306"],
    [["https://app.test", "http://app.test"], "https://app.test, http://app.test"],
  ] as const)("renders endpoints %j", (endpoints, expected) => {
    const result = scopedConnectionText(connections(endpoints), "host");
    expect(result).toBe(expected);
  });

  test.each([
    [[], ""],
    [["tcp://db:3307"], "tcp://db:3307"],
    [["http://web:3000", "tcp://web:9000"], "http://web:3000, tcp://web:9000"],
  ] as const)("renders internal addresses %j with a placeholder when empty", (internal, expected) => {
    const result = scopedConnectionText(connections(internal, "app"), "app");
    expect(result).toBe(expected);
  });

  test("says no endpoints only when host and app-network addresses are both empty", () => {
    const result = serviceStateRow({ name: "db", state: "stopped", connections: [] });
    expect(result).toBe("db (stopped) no endpoints");
  });

  test("renders a service with ordered host endpoints", () => {
    const result = serviceStateRow({
      name: "web",
      state: "running",
      connections: connections(["https://app.test", "http://app.test"]),
    });
    expect(result).toBe("web (running) Host: https://app.test, http://app.test");
  });

  test("renders an internal-only database as an app-network address, not no endpoints", () => {
    // Given a database that listens only on the app network, on a moved port.
    const result = serviceStateRow({
      name: "db",
      state: "ready",
      connections: connections(["tcp://db:3307"], "app"),
    });
    // Then the row names the address other services can reach.
    expect(result).toBe("db (ready) App Network: tcp://db:3307");
    expect(result).not.toContain("no endpoints");
  });

  test("lists host URLs before app-network addresses when a service has both", () => {
    const result = serviceStateRow({
      name: "web",
      state: "running",
      connections: [
        ...connections(["https://app.test", "http://localhost:3000"]),
        ...connections(["http://web:3000", "tcp://web:9229"], "app"),
      ],
    });
    expect(result).toBe(
      "web (running) Host: https://app.test, http://localhost:3000 App Network: http://web:3000, tcp://web:9229",
    );
  });

  test.each([
    [[], ""],
    [["db (stopped) no endpoints"], "db (stopped) no endpoints"],
    [
      ["web (running) https://app.test", "db (stopped) no endpoints"],
      "web (running) https://app.test; db (stopped) no endpoints",
    ],
  ] as const)("joins rows %j without changing separators", (rows, expected) => {
    const result = joinServiceRows(rows);
    expect(result).toBe(expected);
  });
});
