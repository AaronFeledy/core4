import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { assertAdvertisedForward } from "../src/proxy-setup.ts";

describe("assertAdvertisedForward", () => {
  test("probes the HTTPS authority with TLS even when the port is not 443", async () => {
    // Given: occupied-hop advertised 8080/8443.
    const calls: Array<{ readonly port: number; readonly role: string }> = [];

    // When: setup checks advertised forward.
    await Effect.runPromise(
      assertAdvertisedForward(
        {
          probeForward: (_host, port, role) =>
            Effect.sync(() => {
              calls.push({ port, role });
              return { kind: "success" as const };
            }),
        },
        { http: 8080, https: 8443 },
      ),
    );

    // Then: 8443 is probed as https, not plain http.
    expect(calls).toEqual([
      { port: 8080, role: "http" },
      { port: 8443, role: "https" },
    ]);
  });
});
