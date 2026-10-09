import { describe, expect, test } from "bun:test";

import { envOverlay } from "../src/overlay.ts";

describe("envOverlay hostEvents drop", () => {
  test("drops LANDO_CONFIG__HOST_EVENTS at path length 1", () => {
    const overlay = envOverlay({
      LANDO_CONFIG__HOST_EVENTS: JSON.stringify({ "pre-start": ["echo host"] }),
      LANDO_CONFIG__DEFAULT_PROVIDER_ID: "podman",
    });
    expect(overlay).not.toHaveProperty("hostEvents");
    expect(overlay.defaultProviderId).toBe("podman");
  });

  test("drops a nested hostEvents env path", () => {
    const overlay = envOverlay({
      LANDO_CONFIG__HOST_EVENTS__PRE_START: JSON.stringify(["echo host"]),
    });
    expect(overlay).not.toHaveProperty("hostEvents");
  });

  test("drops whole-value JSON assigned at hostEvents", () => {
    const overlay = envOverlay({
      LANDO_CONFIG__HOST_EVENTS: '{"pre-start":[{"cmd":"echo host","service":":host"}]}',
    });
    expect(overlay).toEqual({});
  });
});
