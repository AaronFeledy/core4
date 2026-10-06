import { describe, expect, test } from "bun:test";
import {
  INFO_STATUS_TONES,
  SCRATCH_STATUS_TONES,
  START_STATUS_TONES,
  endpointText,
  joinServiceRows,
  lifecycleLine,
  serviceRowsText,
  serviceStateRow,
  summaryToneFromTable,
  teardownLine,
  unchangedLine,
  volumesTrailer,
} from "../../src/cli/commands/service-summary";

describe("service summary", () => {
  test("renders empty lifecycle rows without a separator", () => {
    // Given
    const services: ReadonlyArray<{
      readonly name: string;
      readonly state: string;
      readonly endpoints: ReadonlyArray<string>;
    }> = [];
    // When
    const rows = serviceRowsText(services);
    // Then
    expect(rows).toBe("");
    expect(lifecycleLine("ready", "app", rows)).toBe("ready: app");
  });

  test("renders lifecycle rows in supplied order", () => {
    // Given
    const services = [{ name: "a", state: "running", endpoints: [] }];
    // When
    const line = lifecycleLine("rebuilt", "app", serviceRowsText(services));
    // Then
    expect(line).toBe("rebuilt: app - a (running) no endpoints");
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
    ["ready", "ok", "info", "info"],
    ["healthy", "warn", "ok", "info"],
    ["starting", "pending", "pending", "info"],
    ["stopped", "skipped", "skipped", "info"],
    ["unhealthy", "error", "error", "info"],
    ["error", "error", "error", "info"],
    ["failed", "error", "info", "info"],
    ["attached", "warn", "info", "ok"],
    ["detached", "warn", "info", "skipped"],
    ["orphan", "warn", "info", "error"],
    ["unknown", "warn", "info", "info"],
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
    [[], "no endpoints"],
    [["tcp://db:3306"], "tcp://db:3306"],
    [["https://app.test", "http://app.test"], "https://app.test, http://app.test"],
  ] as const)("renders endpoints %j", (endpoints, expected) => {
    const result = endpointText(endpoints);
    expect(result).toBe(expected);
  });

  test("renders a service without endpoints", () => {
    const result = serviceStateRow("db", "stopped", []);
    expect(result).toBe("db (stopped) no endpoints");
  });

  test("renders a service with ordered endpoints", () => {
    const result = serviceStateRow("web", "running", ["https://app.test", "http://app.test"]);
    expect(result).toBe("web (running) https://app.test, http://app.test");
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
