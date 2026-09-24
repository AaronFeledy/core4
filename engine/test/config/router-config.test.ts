import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { GlobalConfig, RouterConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import {
  extractRouterPins,
  mergeRouterConfig,
  resolveRouterConfigForApp,
} from "../../src/config/router-config.ts";

const DEFAULT_HTTP_PORTS = [80, 8080, 8000, 8888, 8008, 18080, 28080, 38080] as const;
const DEFAULT_HTTPS_PORTS = [443, 8443, 4443, 4433, 4444, 444, 18443, 28443, 38443] as const;

const globalRouterLayer = (router: RouterConfig) => {
  const load = Effect.succeed({ router } as GlobalConfig);
  return Layer.succeed(ConfigService, {
    load,
    get: <K extends keyof GlobalConfig>(key: K) => Effect.map(load, (config): GlobalConfig[K] => config[key]),
  });
};

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
    expect(merged.httpPorts).toEqual([9080, 8080, 8000, 8888, 8008, 18080, 28080, 38080]);
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

describe("resolveRouterConfigForApp", () => {
  test("returns compiled lists and empty pins when ConfigService is absent", async () => {
    // Given: no ConfigService in the runtime
    // When
    const result = await Effect.runPromise(resolveRouterConfigForApp());
    // Then
    expect(result.router).toEqual({ enabled: true, bindAddress: "127.0.0.1" });
    expect(result.routerPin).toEqual({});
  });

  test("overlays Landofile preferred ports onto compiled lists and extracts pins", async () => {
    // Given
    const landofileRouter = { httpPort: 9090, httpsPort: 9443 };
    // When
    const result = await Effect.runPromise(resolveRouterConfigForApp(landofileRouter));
    // Then
    expect(result.router.httpPort).toBe(9090);
    expect(result.router.httpFallbacks).toBeUndefined();
    expect(result.router.httpsPort).toBe(9443);
    expect(result.router.httpsFallbacks).toBeUndefined();
    expect(result.routerPin).toEqual({ httpPort: 9090, httpsPort: 9443 });
  });

  test("preserves explicit global defaults and an explicit preferred port", async () => {
    const globalRouter = {
      httpPort: 80,
      httpFallbacks: [...DEFAULT_HTTP_PORTS.slice(1)],
      httpsPort: 443,
      httpsFallbacks: [...DEFAULT_HTTPS_PORTS.slice(1)],
    };
    const result = await Effect.runPromise(
      resolveRouterConfigForApp().pipe(Effect.provide(globalRouterLayer(globalRouter))),
    );
    expect(result.router).toEqual({ enabled: true, bindAddress: "127.0.0.1", ...globalRouter });
    expect(result.routerPin).toEqual({});

    const preferredOnly = await Effect.runPromise(
      resolveRouterConfigForApp().pipe(Effect.provide(globalRouterLayer({ httpPort: 80 }))),
    );
    expect(preferredOnly.router).toEqual({ enabled: true, bindAddress: "127.0.0.1", httpPort: 80 });
    expect(preferredOnly.routerPin).toEqual({});
  });

  test("records Landofile router disablement while retaining explicit port settings", async () => {
    const result = await Effect.runPromise(
      resolveRouterConfigForApp({ enabled: false, httpPort: 9090 }).pipe(
        Effect.provide(globalRouterLayer({ enabled: true, httpPort: 8080 })),
      ),
    );
    expect(result.enabled).toBe(false);
    expect(result.router).toEqual({ enabled: false, bindAddress: "127.0.0.1", httpPort: 9090 });
    expect(result.routerPin).toEqual({ httpPort: 9090 });
  });

  test("keeps per-field global and Landofile precedence without inventing omitted fields", async () => {
    const result = await Effect.runPromise(
      resolveRouterConfigForApp({ httpPort: 9090, httpsFallbacks: [] }).pipe(
        Effect.provide(globalRouterLayer({ httpPort: 80, httpFallbacks: [9000], httpsPort: 443 })),
      ),
    );
    expect(result.router).toEqual({
      enabled: true,
      bindAddress: "127.0.0.1",
      httpPort: 9090,
      httpFallbacks: [9000],
      httpsPort: 443,
      httpsFallbacks: [],
    });
    expect(result.routerPin).toEqual({ httpPort: 9090 });
  });
});
