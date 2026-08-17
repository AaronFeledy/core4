import { describe, expect, test } from "bun:test";

import { ensureHostProxyNoProxy } from "../../../src/subsystems/host-proxy/proxy-bypass.ts";

describe("host proxy NO_PROXY bypass", () => {
  test("appends the target to existing entries and synchronizes both casings", () => {
    // Given: proxy configuration with an existing uppercase bypass list and stale lowercase value.
    const env: NodeJS.ProcessEnv = {
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost",
    };
    const processNoProxy = process.env.NO_PROXY;
    const processNoProxyLowercase = process.env.no_proxy;

    // When: the host proxy ensures the target host bypasses the configured proxy.
    ensureHostProxyNoProxy("app.lndo.site", env);

    // Then: both casings carry the same merged bypass list without touching process.env.
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,app.lndo.site");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,app.lndo.site");
    expect(process.env.NO_PROXY).toBe(processNoProxy);
    expect(process.env.no_proxy).toBe(processNoProxyLowercase);
  });

  test("does not duplicate an already-present target while synchronizing both casings", () => {
    // Given: the target is already present in the canonical bypass list.
    const env: NodeJS.ProcessEnv = {
      http_proxy: "http://proxy.internal:3128",
      NO_PROXY: "localhost,app.lndo.site",
      no_proxy: "localhost",
    };

    // When: the host proxy ensures the same target again.
    ensureHostProxyNoProxy("app.lndo.site", env);

    // Then: the target is not duplicated and lowercase no_proxy is refreshed.
    expect(env.NO_PROXY).toBe("localhost,app.lndo.site");
    expect(env.no_proxy).toBe("localhost,app.lndo.site");
  });

  test("preserves wildcard bypass semantics while synchronizing both casings", () => {
    // Given: wildcard bypass already disables proxy use for every target.
    const env: NodeJS.ProcessEnv = {
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "*",
      no_proxy: "localhost",
    };

    // When: the host proxy ensures a specific target.
    ensureHostProxyNoProxy("app.lndo.site", env);

    // Then: wildcard remains the complete bypass list in both casings.
    expect(env.NO_PROXY).toBe("*");
    expect(env.no_proxy).toBe("*");
  });
});
