import { expect, test } from "bun:test";

import { AppId, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import { DEFAULT_AUTHORITY_PORTS, persistedAuthorities, renderTraefikDynamicConfig } from "../src/routing.ts";

const app = AppId.make("literal-test");
const base: RoutePlan = {
  hostname: "demo.lndo.site",
  priority: 2,
  scheme: "http",
  service: ServiceName.make("web"),
  backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
};

test.each([
  ["backtick", "/a`b", '"/a`b"'],
  ["injection", "/x`) || Host(`other.test", '"/x`) || Host(`other.test"'],
  ["quoted injection", '/x") || Host("other.test', '"/x\\") || Host(\\"other.test"'],
  ["backslashes", '/a\\b\\"c', '"/a\\\\b\\\\\\"c"'],
  ["controls", "/\u0000\b\f\n\t\r\u007f", '"/\\u0000\\u0008\\u000c\\n\\t\\r\\u007f"'],
  ["lone surrogates", "/\ud800x\udfff", '"/�x�"'],
  ["unicode pair", "/😀", '"/😀"'],
  ["byte order mark", "/\ufeff", '"/\\ufeff"'],
])("renders %s as one interpreted PathPrefix argument in valid YAML", (_name, pathPrefix, literal) => {
  // Given
  const route = { ...base, pathPrefix };
  // When
  const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
  // Then
  expect(parsed).toHaveProperty(
    "http.routers.route-literal-test-0-http.rule",
    `Host("demo.lndo.site") && PathPrefix(${literal})`,
  );
});

test.each([
  ["demo.lndo.site", 'Host("demo.lndo.site")'],
  ["*.API.*.SITE", 'HostRegexp("^[a-z0-9-]+\\\\.api\\\\.[a-z0-9-]+\\\\.site$")'],
])("round-trips the hostname %s through quoted rules and persisted YAML", (hostname, rule) => {
  // Given
  const route = { ...base, hostname, pathPrefix: '/a`b"\\c' };
  // When
  const yaml = renderTraefikDynamicConfig([route], app);
  // Then
  expect(Bun.YAML.parse(yaml)).toHaveProperty(
    "http.routers.route-literal-test-0-http.rule",
    `${rule} && PathPrefix("/a\`b\\\"\\\\c")`,
  );
  expect(persistedAuthorities(yaml, DEFAULT_AUTHORITY_PORTS)).toEqual([
    { scheme: "http", hostname: hostname.toLowerCase(), port: DEFAULT_AUTHORITY_PORTS.http },
  ]);
});
