import { describe, expect, it } from "bun:test";
import { Either, Schema } from "effect";

import { GlobalConfig, LandofileShape, ProxyConfig, RouterConfig } from "@lando/sdk/schema";

const decodeRouter = Schema.decodeUnknownSync(RouterConfig);
const decodeRouterStrict = Schema.decodeUnknownSync(RouterConfig, { onExcessProperty: "error" });
const decodeGlobal = Schema.decodeUnknownSync(GlobalConfig);
const decodeGlobalStrict = Schema.decodeUnknownSync(GlobalConfig, { onExcessProperty: "error" });
const decodeLandofile = Schema.decodeUnknownSync(LandofileShape);
const decodeLandofileStrict = Schema.decodeUnknownSync(LandofileShape, { onExcessProperty: "error" });
const decodeProxy = Schema.decodeUnknownSync(ProxyConfig);
const decodeProxyStrict = Schema.decodeUnknownSync(ProxyConfig, { onExcessProperty: "error" });

const fullRouter = {
  enabled: true,
  bindAddress: "127.0.0.1",
  httpPort: 80,
  httpsPort: 443,
  httpFallbacks: [8080, 8000],
  httpsFallbacks: [8443],
} as const;

describe("RouterConfig", () => {
  it("decodes an empty object when no fields are set", () => {
    // Given / When
    const decoded = decodeRouter({});

    // Then
    expect(decoded.enabled).toBeUndefined();
    expect(decoded.bindAddress).toBeUndefined();
    expect(decoded.httpPort).toBeUndefined();
    expect(decoded.httpsPort).toBeUndefined();
    expect(decoded.httpFallbacks).toBeUndefined();
    expect(decoded.httpsFallbacks).toBeUndefined();
  });

  it("decodes every optional field when all are present", () => {
    // Given / When
    const decoded = decodeRouter(fullRouter);

    // Then
    expect(decoded.enabled).toBe(true);
    expect(decoded.bindAddress).toBe("127.0.0.1");
    expect(decoded.httpPort).toBe(80);
    expect(decoded.httpsPort).toBe(443);
    expect(decoded.httpFallbacks).toEqual([8080, 8000]);
    expect(decoded.httpsFallbacks).toEqual([8443]);
  });

  it("accepts httpPort when it is the PortNumber lower bound", () => {
    // Given / When
    const decoded = decodeRouter({ httpPort: 1 });

    // Then
    expect(decoded.httpPort).toBe(1);
  });

  it("accepts httpsPort when it is the PortNumber upper bound", () => {
    // Given / When
    const decoded = decodeRouter({ httpsPort: 65_535 });

    // Then
    expect(decoded.httpsPort).toBe(65_535);
  });

  it("rejects httpPort when it is below the PortNumber lower bound", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(RouterConfig)({ httpPort: 0 });

    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects httpsPort when it is above the PortNumber upper bound", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(RouterConfig)({ httpsPort: 65_536 });

    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects httpFallbacks when an entry is outside PortNumber bounds", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(RouterConfig)({ httpFallbacks: [80, 0] });

    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  it("preserves empty httpFallbacks when the array is authored empty", () => {
    // Given / When
    const decoded = decodeRouter({ httpFallbacks: [] });

    // Then
    expect(decoded.httpFallbacks).toEqual([]);
  });

  it("round-trips decode(decode(x)) when using default and onExcessProperty error", () => {
    const inputs = [{}, fullRouter, { httpFallbacks: [] }] as const;

    for (const input of inputs) {
      for (const decode of [decodeRouter, decodeRouterStrict]) {
        // Given
        const once = decode(input);
        // When — second pass must accept the first decode's canonical output
        const twice = decode(once);
        // Then
        expect(twice).toEqual(once);
      }
    }
  });
});

describe("GlobalConfig.router", () => {
  it("leaves router undefined when the key is omitted", () => {
    // Given / When
    const decoded = decodeGlobal({});

    // Then
    expect(decoded.router).toBeUndefined();
  });

  it("keeps an empty router object when router is present without keys", () => {
    // Given / When
    const decoded = decodeGlobal({ router: {} });

    // Then
    expect(decoded.router).toBeDefined();
    expect(decoded.router?.httpPort).toBeUndefined();
    expect(decoded.router?.httpFallbacks).toBeUndefined();
  });

  it("decodes enabled when GlobalConfig sets it", () => {
    // Given / When
    const decoded = decodeGlobal({ router: { enabled: false, httpPort: 8080 } });

    // Then
    expect(decoded.router?.enabled).toBe(false);
    expect(decoded.router?.httpPort).toBe(8080);
  });

  it("round-trips decode(decode(x)) when using default and onExcessProperty error", () => {
    const inputs = [{}, { router: {} }, { router: { enabled: true, httpPort: 80 } }] as const;

    for (const input of inputs) {
      for (const decode of [decodeGlobal, decodeGlobalStrict]) {
        // Given
        const once = decode(input);
        // When
        const twice = decode(once);
        // Then
        expect(twice.router).toEqual(once.router);
      }
    }
  });
});

describe("LandofileShape.router", () => {
  it("leaves router undefined when the key is omitted", () => {
    // Given / When
    const decoded = decodeLandofile({ name: "myapp" });

    // Then
    expect(decoded.router).toBeUndefined();
  });

  it("keeps an empty router object when router is present without keys", () => {
    // Given / When
    const decoded = decodeLandofile({ name: "myapp", router: {} });

    // Then
    expect(decoded.router).toBeDefined();
    expect(decoded.router?.enabled).toBeUndefined();
  });

  it("accepts Landofile router when the YAML router key is present under excess-error", () => {
    // Given — YAML `router:` becomes this object after parse
    const fromYaml = {
      name: "myapp",
      router: { bindAddress: "127.0.0.1", httpPort: 80, httpsPort: 443 },
    };

    // When
    const decoded = decodeLandofileStrict(fromYaml);

    // Then
    expect(decoded.router?.bindAddress).toBe("127.0.0.1");
    expect(decoded.router?.httpPort).toBe(80);
    expect(decoded.router?.httpsPort).toBe(443);
  });

  it("allows Landofile router without enabled when only ports are set", () => {
    // Given / When
    const decoded = decodeLandofile({ name: "myapp", router: { httpPort: 8080 } });

    // Then
    expect(decoded.router?.enabled).toBeUndefined();
    expect(decoded.router?.httpPort).toBe(8080);
  });

  it("round-trips decode(decode(x)) when using default and onExcessProperty error", () => {
    const inputs = [
      { name: "myapp" },
      { name: "myapp", router: {} },
      { name: "myapp", router: { httpPort: 80, httpFallbacks: [] } },
    ] as const;

    for (const input of inputs) {
      for (const decode of [decodeLandofile, decodeLandofileStrict]) {
        // Given
        const once = decode(input);
        // When
        const twice = decode(once);
        // Then
        expect(twice.router).toEqual(once.router);
      }
    }
  });
});

describe("ProxyConfig.router", () => {
  it("decodes router when nested under ProxyConfig", () => {
    // Given / When
    const decoded = decodeProxy({
      defaultDomain: "lndo.site",
      router: { httpPort: 80, httpsPort: 443 },
    });

    // Then
    expect(decoded.router?.httpPort).toBe(80);
    expect(decoded.router?.httpsPort).toBe(443);
  });

  it("decodes routerPin when httpPort and httpsPort are set", () => {
    // Given / When
    const decoded = decodeProxy({
      defaultDomain: "example.test",
      routerPin: { httpPort: 8080, httpsPort: 8443 },
    });

    // Then
    expect(decoded.routerPin?.httpPort).toBe(8080);
    expect(decoded.routerPin?.httpsPort).toBe(8443);
  });

  it("leaves routerPin ports undefined when routerPin is present without keys", () => {
    // Given / When
    const decoded = decodeProxy({ defaultDomain: "lndo.site", routerPin: {} });

    // Then
    expect(decoded.routerPin).toBeDefined();
    expect(decoded.routerPin?.httpPort).toBeUndefined();
    expect(decoded.routerPin?.httpsPort).toBeUndefined();
  });

  it("round-trips decode(decode(x)) when using default and onExcessProperty error", () => {
    const inputs = [
      { defaultDomain: "lndo.site" },
      { defaultDomain: "lndo.site", router: { httpPort: 80 } },
      { defaultDomain: "example.test", routerPin: { httpPort: 8080, httpsPort: 8443 } },
    ] as const;

    for (const input of inputs) {
      for (const decode of [decodeProxy, decodeProxyStrict]) {
        // Given
        const once = decode(input);
        // When
        const twice = decode(once);
        // Then
        expect(twice.router).toEqual(once.router);
        expect(twice.routerPin).toEqual(once.routerPin);
      }
    }
  });
});
