import { describe, expect, test } from "bun:test";

import {
  type ResolvedNetworkTrust,
  fetchInitForNetwork,
  resolveNetworkTrustPlan,
  shouldBypassProxy,
} from "@lando/sdk/network-trust";

const trust = (overrides: Partial<ResolvedNetworkTrust> = {}): ResolvedNetworkTrust => ({
  proxy: { noProxy: [], ...overrides.proxy },
  caPems: overrides.caPems ?? [],
  trustHost: overrides.trustHost ?? true,
});

describe("shouldBypassProxy", () => {
  test("wildcard bypasses everything", () => {
    expect(shouldBypassProxy("https://example.com/x", ["*"])).toBe(true);
  });

  test("exact host match bypasses", () => {
    expect(shouldBypassProxy("https://example.com/x", ["example.com"])).toBe(true);
    expect(shouldBypassProxy("https://other.com/x", ["example.com"])).toBe(false);
  });

  test("host:port match bypasses", () => {
    expect(shouldBypassProxy("https://example.com:8443/x", ["example.com:8443"])).toBe(true);
    expect(shouldBypassProxy("https://example.com/x", ["example.com:443"])).toBe(true);
  });

  test("leading-dot suffix and bare suffix match subdomains", () => {
    expect(shouldBypassProxy("https://api.example.com/x", [".example.com"])).toBe(true);
    expect(shouldBypassProxy("https://api.example.com/x", ["example.com"])).toBe(true);
    expect(shouldBypassProxy("https://example.com/x", [".example.com"])).toBe(false);
  });

  test("empty noProxy never bypasses", () => {
    expect(shouldBypassProxy("https://example.com/x", [])).toBe(false);
  });
});

const SYS_A = "-----BEGIN CERTIFICATE-----\nSYS-A\n-----END CERTIFICATE-----";
const SYS_B = "-----BEGIN CERTIFICATE-----\nSYS-B\n-----END CERTIFICATE-----";

describe("fetchInitForNetwork", () => {
  test("returns undefined when no proxy and no CA apply", () => {
    expect(fetchInitForNetwork("https://example.com", trust(), [])).toBeUndefined();
  });

  test("applies https proxy for https URLs", () => {
    const init = fetchInitForNetwork(
      "https://example.com",
      trust({ proxy: { noProxy: [], https: "http://proxy:3128" } }),
      [],
    );
    expect(init).toEqual({ proxy: "http://proxy:3128" });
  });

  test("https URL falls back to http proxy when https proxy absent", () => {
    const init = fetchInitForNetwork(
      "https://example.com",
      trust({ proxy: { noProxy: [], http: "http://proxy:3128" } }),
      [],
    );
    expect(init).toEqual({ proxy: "http://proxy:3128" });
  });

  test("http URL prefers http proxy", () => {
    const init = fetchInitForNetwork(
      "http://example.com",
      trust({ proxy: { noProxy: [], http: "http://h:1", https: "http://s:2" } }),
      [],
    );
    expect(init).toEqual({ proxy: "http://h:1" });
  });

  test("noProxy match omits proxy", () => {
    const init = fetchInitForNetwork(
      "https://example.com",
      trust({ proxy: { noProxy: ["example.com"], https: "http://proxy:3128" } }),
      [],
    );
    expect(init).toBeUndefined();
  });

  test("applies both proxy and CA", () => {
    const init = fetchInitForNetwork(
      "https://example.com",
      trust({ proxy: { noProxy: [], https: "http://proxy:3128" }, caPems: ["PEM"] }),
      [],
    );
    expect(init).toEqual({ proxy: "http://proxy:3128", tls: { ca: ["PEM"] } });
  });
});

describe("fetchInitForNetwork trustHost CA merge", () => {
  test("trustHost=true with custom PEMs merges system roots and custom PEMs", () => {
    const init = fetchInitForNetwork("https://example.com", trust({ caPems: ["CUSTOM"] }), [SYS_A, SYS_B]);
    expect(init).toEqual({ tls: { ca: [SYS_A, SYS_B, "CUSTOM"] } });
  });

  test("trustHost=true with no custom PEMs leaves tls.ca unset", () => {
    expect(fetchInitForNetwork("https://example.com", trust({ caPems: [] }), [SYS_A, SYS_B])).toBeUndefined();
  });

  test("trustHost=true with no custom PEMs still omits tls.ca when a proxy applies", () => {
    const init = fetchInitForNetwork(
      "https://example.com",
      trust({ proxy: { noProxy: [], https: "http://proxy:3128" }, caPems: [] }),
      [SYS_A],
    );
    expect(init).toEqual({ proxy: "http://proxy:3128" });
  });

  test("trustHost=false with custom PEMs uses only the custom PEMs", () => {
    const init = fetchInitForNetwork("https://example.com", trust({ caPems: ["CUSTOM"], trustHost: false }), [
      SYS_A,
      SYS_B,
    ]);
    expect(init).toEqual({ tls: { ca: ["CUSTOM"] } });
  });

  test("trustHost=false with no custom PEMs fails closed with an empty ca list", () => {
    const init = fetchInitForNetwork("https://example.com", trust({ caPems: [], trustHost: false }), [
      SYS_A,
      SYS_B,
    ]);
    expect(init).toEqual({ tls: { ca: [] } });
  });
});

describe("resolveNetworkTrustPlan", () => {
  test("config proxy takes precedence over env proxy", () => {
    const plan = resolveNetworkTrustPlan(
      { network: { proxy: { http: "http://cfg:1", https: "http://cfg:2", noProxy: ["a.com"] } } },
      { HTTP_PROXY: "http://env:9", HTTPS_PROXY: "http://env:8", NO_PROXY: "z.com" },
    );
    expect(plan.proxy).toEqual({ http: "http://cfg:1", https: "http://cfg:2", noProxy: ["a.com"] });
  });

  test("falls back to env proxy vars when no config proxy", () => {
    const plan = resolveNetworkTrustPlan(
      {},
      { HTTP_PROXY: "http://env:9", HTTPS_PROXY: "http://env:8", NO_PROXY: "z.com, .y.com" },
    );
    expect(plan.proxy).toEqual({ http: "http://env:9", https: "http://env:8", noProxy: ["z.com", ".y.com"] });
  });

  test("lowercase env proxy vars are honored", () => {
    const plan = resolveNetworkTrustPlan({}, { http_proxy: "http://lower:9" });
    expect(plan.proxy.http).toBe("http://lower:9");
  });

  test("config null proxy value disables that proxy without falling back to env", () => {
    const plan = resolveNetworkTrustPlan(
      { network: { proxy: { http: null, https: "http://cfg:2", noProxy: [] } } },
      { HTTP_PROXY: "http://env:9" },
    );
    expect(plan.proxy.http).toBeUndefined();
    expect(plan.proxy.https).toBe("http://cfg:2");
  });

  test("collects CA cert paths from config and env, config first", () => {
    const plan = resolveNetworkTrustPlan(
      { network: { ca: { certs: ["/cfg/a.pem"], trustHost: false } } },
      { LANDO_NETWORK_CA_CERTS: JSON.stringify(["/env/b.pem"]) },
    );
    expect(plan.caCertPaths).toEqual(["/cfg/a.pem", "/env/b.pem"]);
    expect(plan.trustHost).toBe(false);
  });

  test("trustHost defaults to true and certs default to empty", () => {
    const plan = resolveNetworkTrustPlan({}, {});
    expect(plan.trustHost).toBe(true);
    expect(plan.caCertPaths).toEqual([]);
  });

  test("invalid LANDO_NETWORK_CA_CERTS throws a tagged error", () => {
    expect(() => resolveNetworkTrustPlan({}, { LANDO_NETWORK_CA_CERTS: "not-json" })).toThrow();
  });
});
