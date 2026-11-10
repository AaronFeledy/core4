import { describe, expect, test } from "bun:test";

import { hasHostSystemd } from "../src/user-systemd-session.ts";

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
