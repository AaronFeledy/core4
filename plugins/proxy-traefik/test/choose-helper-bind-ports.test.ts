import { describe, expect, test } from "bun:test";

import { chooseHelperBindPorts } from "../src/port-acquisition.ts";

describe("chooseHelperBindPorts", () => {
  test("binds HTTP on 8000 when 8080 is occupied", () => {
    // Given: 8080 occupied and 8000 free; HTTPS 8443 free.
    // When: chooseHelperBindPorts walks the HTTP try list.
    const chosen = chooseHelperBindPorts({
      httpBinds: {
        8080: { kind: "EADDRINUSE", code: "EADDRINUSE" },
        8000: { kind: "success" },
      },
      httpsBinds: {
        8443: { kind: "success" },
      },
    });

    // Then: bind HTTP is 8000 and HTTPS is 8443.
    expect(chosen.bindHttpPort).toBe(8000);
    expect(chosen.bindHttpsPort).toBe(8443);
  });

  test("uses a pinned preferred high port as the hop target", () => {
    // Given: try lists start at 8080/8443 and those binds succeed.
    const chosen = chooseHelperBindPorts({
      httpTryList: [8080, 8000, 38080],
      httpsTryList: [8443, 4443, 38443],
      httpBinds: {
        8080: { kind: "success" },
      },
      httpsBinds: {
        8443: { kind: "success" },
      },
    });

    // Then: hops are 8080/8443, not the next fallback.
    expect(chosen.bindHttpPort).toBe(8080);
    expect(chosen.bindHttpsPort).toBe(8443);
  });
});
