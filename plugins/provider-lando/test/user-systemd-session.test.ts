import { describe, expect, test } from "bun:test";

import { hasUsableUserSystemdSession } from "../src/user-systemd-session.ts";

describe("hasUsableUserSystemdSession", () => {
  test("is true when the user systemd private socket exists", () => {
    expect(
      hasUsableUserSystemdSession({
        runtimeDir: "/run/user/1000",
        exists: (path) => path === "/run/user/1000/systemd/private",
      }),
    ).toBe(true);
  });

  test("is true when the user session bus exists", () => {
    expect(
      hasUsableUserSystemdSession({
        runtimeDir: "/run/user/1000",
        exists: (path) => path === "/run/user/1000/bus",
      }),
    ).toBe(true);
  });

  test("is false when the runtime dir has no session sockets", () => {
    expect(
      hasUsableUserSystemdSession({
        runtimeDir: "/run/user/1000",
        exists: () => false,
      }),
    ).toBe(false);
  });

  test("is false when no runtime dir can be resolved", () => {
    expect(hasUsableUserSystemdSession({ runtimeDir: "", exists: () => true })).toBe(false);
  });
});
