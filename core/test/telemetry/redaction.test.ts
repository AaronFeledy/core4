import { describe, expect, test } from "bun:test";

import { redactTelemetryData, scrubTelemetryValue } from "../../src/telemetry/redaction.ts";

describe("scrubTelemetryValue", () => {
  test("removes POSIX absolute paths", () => {
    const out = scrubTelemetryValue("ENOENT: open '/home/alice/project/.lando.yml'");
    expect(out).not.toContain("/home/alice");
    expect(out).not.toContain("alice");
    expect(out).toContain("[path]");
  });

  test("removes Windows paths", () => {
    const out = scrubTelemetryValue("could not read C:\\Users\\alice\\project\\.lando.yml");
    expect(out).not.toContain("C:\\Users");
    expect(out).not.toContain("alice");
    expect(out).toContain("[path]");
  });

  test("removes UNC Windows paths", () => {
    const out = scrubTelemetryValue("share at \\\\server\\public\\team");
    expect(out).not.toContain("\\\\server");
    expect(out).toContain("[path]");
  });

  test("removes home-directory aliases", () => {
    const out = scrubTelemetryValue("config in ~/projects/secret-app");
    expect(out).not.toContain("~/projects");
    expect(out).not.toContain("secret-app");
    expect(out).toContain("[path]");
  });

  test("removes URLs with embedded credentials", () => {
    const out = scrubTelemetryValue("proxy http://bob:s3cr3t@proxy.corp.example:3128/path failed");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("proxy.corp.example");
    expect(out).toContain("[url]");
  });

  test("removes plain URLs", () => {
    const out = scrubTelemetryValue("download from https://downloads.example.com/lando.tar.gz timed out");
    expect(out).not.toContain("downloads.example.com");
    expect(out).toContain("[url]");
  });

  test("removes email addresses", () => {
    const out = scrubTelemetryValue("notify alice.smith+ci@example.co.uk now");
    expect(out).not.toContain("alice.smith");
    expect(out).not.toContain("example.co.uk");
    expect(out).toContain("[email]");
  });

  test("removes UUID-like identifiers", () => {
    const out = scrubTelemetryValue("session 550e8400-e29b-41d4-a716-446655440000 ended");
    expect(out).not.toContain("550e8400");
    expect(out).toContain("[id]");
  });

  test("removes bare hostnames / FQDNs", () => {
    const out = scrubTelemetryValue("connect db.internal.example.com refused");
    expect(out).not.toContain("db.internal.example.com");
    expect(out).toContain("[host]");
  });

  test("removes high-entropy secret tokens", () => {
    const out = scrubTelemetryValue("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toContain("[redacted]");
  });

  test("removes env-style secret assignments", () => {
    const out = scrubTelemetryValue("DATABASE_PASSWORD=hunter2 in environment");
    expect(out).not.toContain("hunter2");
  });

  test("does not over-redact safe semver, platform keys, or surface ids", () => {
    expect(scrubTelemetryValue("4.0.0")).toBe("4.0.0");
    expect(scrubTelemetryValue("linux-x64")).toBe("linux-x64");
    expect(scrubTelemetryValue("app:start")).toBe("app:start");
    expect(scrubTelemetryValue("@lando/old-plugin")).toBe("@lando/old-plugin");
    expect(scrubTelemetryValue("success")).toBe("success");
  });
});

describe("redactTelemetryData", () => {
  test("allowlists update-outcome to inventory fields and drops everything else", () => {
    const out = redactTelemetryData("update-outcome", {
      version: "4.0.0",
      targetVersion: "4.1.0",
      channel: "stable",
      platform: "linux-x64",
      outcome: "success",
      installDir: "/home/alice/.lando/bin",
      rawError: "boom at /home/alice",
      args: ["--force"],
    });
    expect(out).toEqual({
      version: "4.0.0",
      targetVersion: "4.1.0",
      channel: "stable",
      platform: "linux-x64",
      outcome: "success",
    });
  });

  test("rejects update-outcome enum values outside the inventory allow set", () => {
    const out = redactTelemetryData("update-outcome", {
      version: "4.0.0",
      targetVersion: "4.1.0",
      channel: "experimental",
      platform: "linux-x64",
      outcome: "exploded",
    });
    expect(out).not.toHaveProperty("channel");
    expect(out).not.toHaveProperty("outcome");
    expect(out).toMatchObject({ version: "4.0.0", targetVersion: "4.1.0", platform: "linux-x64" });
  });

  test("scrubs free-string values on allowlisted fields", () => {
    const out = redactTelemetryData("update-outcome", {
      version: "4.0.0",
      targetVersion: "v from /home/alice/build",
      channel: "stable",
      platform: "linux-x64",
      outcome: "network_failure",
    });
    expect(String(out.targetVersion)).not.toContain("/home/alice");
    expect(String(out.targetVersion)).toContain("[path]");
  });

  test("keeps deprecation-used surface identifiers intact", () => {
    const out = redactTelemetryData("deprecation-used", {
      kind: "plugin",
      id: "@lando/old-plugin",
      since: "4.0.0",
      severity: "warn",
    });
    expect(out).toEqual({
      kind: "plugin",
      id: "@lando/old-plugin",
      since: "4.0.0",
      severity: "warn",
    });
  });

  test("scrubs nested payloads for unknown events without dropping structure", () => {
    const out = redactTelemetryData("some-unknown-event", {
      a: { b: ["plain", "/home/alice/x"] },
      c: "user@example.com",
    });
    expect(JSON.stringify(out)).not.toContain("/home/alice");
    expect(JSON.stringify(out)).not.toContain("user@example.com");
    expect(JSON.stringify(out)).toContain("[path]");
    expect(JSON.stringify(out)).toContain("[email]");
  });
});
