import { describe, expect, test } from "bun:test";

import type { RouterConfig } from "@lando/sdk/schema";

import { routerEnabledFrom } from "../../src/config/router-config.ts";

const router = (config: RouterConfig): RouterConfig => config;

describe("routerEnabledFrom", () => {
  test("defaults to enabled when nothing is configured", () => {
    expect(routerEnabledFrom(undefined, undefined)).toBe(true);
  });

  test("global config can disable the router", () => {
    expect(routerEnabledFrom(router({ enabled: false }), undefined)).toBe(false);
  });

  test("landofile can disable a globally enabled router", () => {
    expect(routerEnabledFrom(router({ enabled: true }), router({ enabled: false }))).toBe(false);
  });

  test("landofile can re-enable a globally disabled router", () => {
    expect(routerEnabledFrom(router({ enabled: false }), router({ enabled: true }))).toBe(true);
  });

  test("a landofile that only pins ports inherits global enablement", () => {
    expect(routerEnabledFrom(router({ enabled: false }), router({ httpPort: 8080 }))).toBe(false);
  });
});
