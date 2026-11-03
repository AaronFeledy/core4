import { describe, expect, test } from "bun:test";

import { crontabLine, supercronicInstallCommand } from "../src/crontab.ts";
import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_VERSION } from "../src/supercronic.ts";

describe("schedule crontab", () => {
  test("keeps the parent user and wraps a different job user", () => {
    expect(crontabLine({ name: "tick", every: "@hourly", run: "true" }, "1001")).toBe("@hourly true");
    expect(crontabLine({ name: "tick", every: "@hourly", run: "true", user: "www-data" }, "1001")).toContain(
      "su -s /bin/sh",
    );
  });

  test("pins the scheduler release in the install command", () => {
    const command = supercronicInstallCommand(["@hourly true"]);
    expect(command).toContain(SUPERCRONIC_VERSION);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.arm64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.url);
  });
});
