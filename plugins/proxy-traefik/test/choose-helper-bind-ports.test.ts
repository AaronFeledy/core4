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

    // Then: bind HTTP is 8000.
    expect(chosen.bindHttpPort).toBe(8000);
  });
});
