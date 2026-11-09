import { describe, expect, test } from "bun:test";

import { RouterPortsExhausted } from "@lando/sdk/errors";

import { chooseHelperBindPorts } from "../src/port-acquisition.ts";

describe("chooseHelperBindPorts", () => {
  test("binds Traefik on 38080/38443 when those ports are free", () => {
    // Given: backend defaults are free (no provider proof required).
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "success" },
      },
    });

    // Then: hops are the stable Traefik backends, not 8080/8443.
    expect(chosen.bindHttpPort).toBe(38080);
    expect(chosen.bindHttpsPort).toBe(38443);
  });

  test("keeps 38080 when provider-owned despite EADDRINUSE", () => {
    // Given: 38080 is in use but ownedRouterPorts proves this root owns it.
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "success" },
      },
      ownedPorts: new Set([38080]),
    });

    // Then: do not hop Traefik off a port the provider already owns.
    expect(chosen.bindHttpPort).toBe(38080);
    expect(chosen.bindHttpsPort).toBe(38443);
  });

  test("skips 38080 held by rootlessport without provider ownership and picks 48080", () => {
    // Given: 38080 is EADDRINUSE (e.g. another root's rootlessport) without owned proof.
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48443: { kind: "success" },
      },
      // No ownedPorts: holder name must not decide ownership.
    });

    // Then: backend hops stay on the high-port list.
    expect(chosen.bindHttpPort).toBe(48080);
    expect(chosen.bindHttpsPort).toBe(48443);
  });

  test("does not reuse occupied ports when the owned set is empty", () => {
    // Given: ownership query mapped to empty set (ownedRouterPorts catch path).
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "success" },
      },
      ownedPorts: new Set(),
    });

    // Then: empty owned set never reuses EADDRINUSE backends.
    expect(chosen.bindHttpPort).toBe(48080);
    expect(chosen.bindHttpsPort).toBe(38443);
  });

  test("exhausts when every backend is EADDRINUSE without ownership proof", () => {
    expect(() =>
      chooseHelperBindPorts({
        httpBinds: {
          38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
          48080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
          58080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        },
        httpsBinds: {
          38443: { kind: "EADDRINUSE", code: "EADDRINUSE" },
          48443: { kind: "EADDRINUSE", code: "EADDRINUSE" },
          58443: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        },
        ownedPorts: new Set(),
      }),
    ).toThrow(RouterPortsExhausted);
  });
});
