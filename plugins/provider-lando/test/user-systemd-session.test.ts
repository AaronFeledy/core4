import { describe, expect, test } from "bun:test";

import { hasHostSystemd, hasUsableUserSystemdSession } from "../src/user-systemd-session.ts";

describe("hasUsableUserSystemdSession", () => {
  test("is true when the user systemd private socket exists", () => {
    expect(
      hasUsableUserSystemdSession({
        runtimeDir: "/run/user/1000",
        exists: (path) => path === "/run/user/1000/systemd/private",
      }),
    ).toBe(true);
  });

  test("is false when only a session bus socket exists", () => {
    expect(
      hasUsableUserSystemdSession({
        runtimeDir: "/run/user/1000",
        exists: (path) => path === "/run/user/1000/bus",
      }),
    ).toBe(false);
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

describe("hasHostSystemd", () => {
  test("is false on a tini host without /run/systemd/system", () => {
    expect(hasHostSystemd({ exists: () => false, pid1Comm: "tini" })).toBe(false);
  });

  test("is true when PID 1 is systemd even if the runtime dir is missing", () => {
    expect(hasHostSystemd({ exists: () => false, pid1Comm: "systemd" })).toBe(true);
  });

  test("is true when /run/systemd/system exists even if PID 1 is tini", () => {
    expect(
      hasHostSystemd({
        exists: (path) => path === "/run/systemd/system",
        pid1Comm: "tini",
      }),
    ).toBe(true);
  });

  test("does not treat a systemctl binary as evidence of systemd", () => {
    expect(
      hasHostSystemd({
        exists: (path) => path === "/usr/bin/systemctl",
        pid1Comm: "tini",
      }),
    ).toBe(false);
  });
});
