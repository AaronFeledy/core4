import { describe, expect, test } from "bun:test";

import { chooseHelperBindPorts } from "../src/port-acquisition.ts";

describe("chooseHelperBindPorts", () => {
  test("binds Traefik on 38080/38443 when those ports are free", () => {
    // Given: backend defaults are free.
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

  test("keeps 38080 when it is already owned by our forwarder", () => {
    // Given: 38080 is in use by rootlessport.
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "success" },
      },
      httpHolders: {
        38080: "rootlessport",
      },
    });

    // Then: do not hop Traefik off a port we already own.
    expect(chosen.bindHttpPort).toBe(38080);
    expect(chosen.bindHttpsPort).toBe(38443);
  });

  test("hops to the next backend pair when 38080 is foreign-occupied", () => {
    // Given: 38080 is held by nginx; 48080 is free.
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        38080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48080: { kind: "success" },
      },
      httpsBinds: {
        38443: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        48443: { kind: "success" },
      },
      httpHolders: {
        38080: "nginx",
      },
      httpsHolders: {
        38443: "nginx",
      },
    });

    // Then: backend hops stay on the high-port list.
    expect(chosen.bindHttpPort).toBe(48080);
    expect(chosen.bindHttpsPort).toBe(48443);
  });
});
