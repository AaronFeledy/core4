import { expect, test } from "bun:test";
import {
  DEFAULT_ROUTER_HTTPS_PORTS,
  DEFAULT_ROUTER_HTTP_PORTS,
  ROUTER_LAST_RESORT_HTTPS_PORT,
  ROUTER_LAST_RESORT_HTTP_PORT,
  RouterPortPair,
  routerPortPairFromAcquisition,
} from "@lando/sdk/schema";
import { Schema } from "effect";

test("last-resort ports match the final router candidates", () => {
  // Given: the ordered router candidates.
  const expected = {
    httpPort: DEFAULT_ROUTER_HTTP_PORTS.at(-1),
    httpsPort: DEFAULT_ROUTER_HTTPS_PORTS.at(-1),
  };
  // When
  const pair = { httpPort: ROUTER_LAST_RESORT_HTTP_PORT, httpsPort: ROUTER_LAST_RESORT_HTTPS_PORT };
  // Then
  expect<number | undefined>(pair.httpPort).toBe(expected.httpPort);
  expect<number | undefined>(pair.httpsPort).toBe(expected.httpsPort);
});

test.each([
  { name: "undefined", input: undefined },
  { name: "null", input: null },
  { name: "number", input: 8080 },
  { name: "string", input: "8080" },
  { name: "empty object", input: {} },
  { name: "array", input: [] },
  { name: "socket helper without binds", input: { mode: "socket-helper", httpPort: 80, httpsPort: 443 } },
  { name: "partial pair", input: { httpPort: 8080 } },
  { name: "fractional HTTP", input: { httpPort: 8080.5, httpsPort: 8443 } },
  { name: "fractional HTTPS", input: { httpPort: 8080, httpsPort: 8443.5 } },
  { name: "zero HTTP", input: { httpPort: 0, httpsPort: 8443 } },
  { name: "oversized HTTPS", input: { httpPort: 8080, httpsPort: 65536 } },
  { name: "string HTTP", input: { httpPort: "8080", httpsPort: 8443 } },
  {
    name: "invalid helper binds",
    input: { mode: "socket-helper", bindHttpPort: 0, bindHttpsPort: 8443, httpPort: 80, httpsPort: 443 },
  },
])("uses last resort when acquisition is $name", ({ input }) => {
  // Given: an acquisition value without a usable publish pair.
  // When
  const pair = routerPortPairFromAcquisition(input);
  // Then
  expect(pair).toEqual({ httpPort: 38080, httpsPort: 38443 });
});

test.each([
  { name: "advertised occupied-hop pair", input: { mode: "occupied-hop", httpPort: 8080, httpsPort: 8443 } },
  {
    name: "bind pair before advertised pair",
    input: { bindHttpPort: 8080, bindHttpsPort: 8443, httpPort: 80, httpsPort: 443 },
  },
  {
    name: "helper bind pair",
    input: { mode: "socket-helper", bindHttpPort: 8080, bindHttpsPort: 8443, httpPort: 80, httpsPort: 443 },
  },
  {
    name: "advertised pair after invalid binds",
    input: { bindHttpPort: 0, bindHttpsPort: 443, httpPort: 8080, httpsPort: 8443 },
  },
  {
    name: "advertised pair after partial binds",
    input: { bindHttpPort: 80, httpPort: 8080, httpsPort: 8443 },
  },
])("selects the $name", ({ input }) => {
  // Given: distinct bind and advertised values where precedence matters.
  // When
  const pair = routerPortPairFromAcquisition(input);
  // Then
  expect(pair).toEqual({ httpPort: 8080, httpsPort: 8443 });
});

test.each([
  [{ httpPort: 1, httpsPort: 65535 }, true],
  [{ httpPort: 0, httpsPort: 443 }, false],
  [{ httpPort: 80, httpsPort: 65536 }, false],
  [{ httpPort: 80.5, httpsPort: 443 }, false],
  [{ httpPort: 80, httpsPort: "443" }, false],
  [{ httpPort: 80 }, false],
] as const)("RouterPortPair checks %j", (input, expected) => {
  // Given: both inclusive bounds and malformed pairs.
  // When
  const valid = Schema.is(RouterPortPair)(input);
  // Then
  expect(valid).toBe(expected);
});
