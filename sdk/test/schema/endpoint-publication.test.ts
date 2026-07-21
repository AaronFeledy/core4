import { describe, expect, test } from "bun:test";

import { type EndpointPlan, isHostPublishedEndpoint } from "@lando/sdk/schema";

describe("isHostPublishedEndpoint", () => {
  test.each([
    ["target-only", { protocol: "http", port: 80 }, false],
    ["bind-only", { protocol: "http", port: 80, bind: "127.0.0.1" }, true],
    ["published-port-only", { protocol: "http", port: 80, publishedPort: 38080 }, true],
    [
      "bind-and-published-port",
      { protocol: "http", port: 80, bind: "127.0.0.1", publishedPort: 38080 },
      true,
    ],
    ["portless", { protocol: "http" }, false],
    ["unix", { protocol: "unix", socketPath: "/run/app.sock" }, false],
  ] satisfies ReadonlyArray<readonly [string, EndpointPlan, boolean]>)(
    "identifies %s endpoint publication intent",
    (_name, endpoint, expected) => {
      expect(isHostPublishedEndpoint(endpoint)).toBe(expected);
    },
  );
});
