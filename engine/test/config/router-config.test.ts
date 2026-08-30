import { describe, expect, test } from "bun:test";

import { extractRouterPins, mergeRouterConfig } from "../../src/config/router-config.ts";

const DEFAULT_HTTP_PORTS = [80, 8080, 8000, 8888, 8008, 38080] as const;
const DEFAULT_HTTPS_PORTS = [443, 8443, 4443, 4433, 4444, 444, 38443] as const;

describe("mergeRouterConfig", () => {
  test("returns compiled HTTP and HTTPS lists when both overlays are omitted", () => {
    // Given
    // When
    const merged = mergeRouterConfig(undefined, undefined);
    // Then
    expect(merged.httpPorts).toEqual([...DEFAULT_HTTP_PORTS]);
    expect(merged.httpsPorts).toEqual([...DEFAULT_HTTPS_PORTS]);
    expect(merged.bindAddress).toBe("127.0.0.1");
  });

  test("replaces the preferred HTTP candidate when httpPort is set", () => {
    // Given
    const globalRouter = { httpPort: 9080 };
    // When
    const merged = mergeRouterConfig(globalRouter, undefined);
    // Then
    expect(merged.httpPorts).toEqual([9080, 8080, 8000, 8888, 8008, 38080]);
    expect(merged.httpsPorts).toEqual([...DEFAULT_HTTPS_PORTS]);
  });

  test("replaces the rest of the HTTP list when httpFallbacks is set", () => {
    // Given
    const globalRouter = { httpFallbacks: [9000, 9001] };
    // When
    const merged = mergeRouterConfig(globalRouter, undefined);
    // Then
    expect(merged.httpPorts).toEqual([80, 9000, 9001]);
  });

  test("inherits omitted keys when the landofile overlay leaves them unset", () => {
    // Given
    const globalRouter = { httpPort: 9080, bindAddress: "0.0.0.0" };
    const landofileRouter = { httpsPort: 9443 };
    // When
    const merged = mergeRouterConfig(globalRouter, landofileRouter);
    // Then
    expect(merged.httpPorts[0]).toBe(9080);
    expect(merged.httpsPorts[0]).toBe(9443);
    expect(merged.bindAddress).toBe("0.0.0.0");
  });

  test("returns a preferred-only HTTP list when httpFallbacks is empty", () => {
    // Given
    const globalRouter = { httpFallbacks: [] };
    // When
    const merged = mergeRouterConfig(globalRouter, undefined);
    // Then
    expect(merged.httpPorts).toEqual([80]);
  });

  test("overlays landofile router keys on global router keys", () => {
    // Given
    const globalRouter = {
      httpPort: 8080,
      httpsPort: 8443,
      httpFallbacks: [9000],
      httpsFallbacks: [9443],
      bindAddress: "10.0.0.1",
    };
    const landofileRouter = { httpPort: 9090, bindAddress: "0.0.0.0" };
    // When
    const merged = mergeRouterConfig(globalRouter, landofileRouter);
    // Then
    expect(merged.httpPorts).toEqual([9090, 9000]);
    expect(merged.httpsPorts).toEqual([8443, 9443]);
    expect(merged.bindAddress).toBe("0.0.0.0");
  });
});

describe("extractRouterPins", () => {
  test("extracts pins from landofile preferred ports when fallbacks are also set", () => {
    // Given
    const landofileRouter = {
      httpPort: 8080,
      httpsPort: 8443,
      httpFallbacks: [9000],
      httpsFallbacks: [9443],
    };
    // When
    const pins = extractRouterPins(landofileRouter);
    // Then
    expect(pins).toEqual({ httpPort: 8080, httpsPort: 8443 });
  });

  test("extracts no pins when the landofile only sets fallbacks", () => {
    // Given
    const landofileRouter = { httpFallbacks: [9000], httpsFallbacks: [9443] };
    // When
    const pins = extractRouterPins(landofileRouter);
    // Then
    expect(pins).toEqual({});
  });
});
