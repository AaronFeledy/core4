import { expect, test } from "bun:test";

import { BindAddress } from "@lando/sdk/schema";

import { publishedEndpointUrl, publishedEndpointUrls } from "../../../src/cli/authority-url.ts";

test("renders only explicitly published endpoint URLs", () => {
  const urls = publishedEndpointUrls([
    { _tag: "internal", protocol: "http", port: 8080 },
    {
      _tag: "published",
      protocol: "https",
      port: 8443,
      publication: { bindAddress: BindAddress.make("127.0.0.1"), hostPort: 38443 },
    },
  ]);

  expect(urls).toEqual(["https://localhost:38443"]);
});

test("uses provider materialization for an assigned host port", () => {
  const url = publishedEndpointUrl({
    _tag: "published",
    protocol: "http",
    port: 8080,
    publication: {},
    materialization: { bindAddress: BindAddress.make("127.0.0.1"), hostPort: 49152 },
  });

  expect(url).toBe("http://localhost:49152");
});

test("brackets IPv6 bind addresses in openable URLs", () => {
  const url = publishedEndpointUrl({
    _tag: "published",
    protocol: "http",
    port: 8080,
    publication: { bindAddress: BindAddress.make("::1"), hostPort: 49152 },
  });

  expect(url).toBe("http://[::1]:49152");
});
