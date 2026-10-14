import { describe, expect, test } from "bun:test";

import {
  DOCKER_API_MAX_TESTED_VERSION,
  DOCKER_API_PREFERRED_VERSION,
  DOCKER_API_PREFIX,
  extractDockerDaemonApiRange,
  formatDockerApiRange,
  negotiateDockerApiVersion,
  parseDockerApiVersionOverride,
} from "../src/docker/api-version.ts";

describe("Docker API version negotiation", () => {
  test("keeps the preferred 1.43 prefix as the documented default", () => {
    expect(DOCKER_API_PREFERRED_VERSION).toBe("1.43");
    expect(DOCKER_API_MAX_TESTED_VERSION).toBe("1.44");
    expect(DOCKER_API_PREFIX).toBe("/v1.43");
  });

  test("uses 1.43 when the daemon only advertises 1.43", () => {
    const negotiated = negotiateDockerApiVersion({ apiVersion: "1.43" });
    expect(negotiated).toEqual({ ok: true, version: "1.43", prefix: "/v1.43" });
  });

  test("raises only to a 1.44 daemon minimum", () => {
    const negotiated = negotiateDockerApiVersion({ minApiVersion: "1.44", apiVersion: "1.51" });
    expect(negotiated).toEqual({ ok: true, version: "1.44", prefix: "/v1.44" });
  });

  test("stays on 1.43 when the daemon publishes a wider range", () => {
    const negotiated = negotiateDockerApiVersion({ minApiVersion: "1.24", apiVersion: "1.45" });
    expect(negotiated).toEqual({ ok: true, version: "1.43", prefix: "/v1.43" });
  });

  test("treats a missing MinAPIVersion as no minimum", () => {
    const negotiated = negotiateDockerApiVersion({ apiVersion: "1.45" });
    expect(negotiated).toEqual({ ok: true, version: "1.43", prefix: "/v1.43" });
  });

  test("fails a Podman-style payload whose ApiVersion is below 1.43", () => {
    const range = extractDockerDaemonApiRange({
      body: JSON.stringify({
        ApiVersion: "1.41",
        Version: "5.2.0",
        Components: [{ Name: "Podman Engine", Version: "5.2.0" }],
      }),
    });
    expect(range).toEqual({ apiVersion: "1.41" });
    const negotiated = negotiateDockerApiVersion(range);
    expect(negotiated.ok).toBe(false);
    if (negotiated.ok) throw new Error("expected negotiation to fail");
    expect(negotiated.ourRange).toBe("1.43-1.44");
    expect(negotiated.daemonRange).toBe("up to 1.41");
    expect(negotiated.message).toContain("1.43-1.44");
    expect(negotiated.message).toContain("up to 1.41");
  });

  test("fails when the daemon minimum is above the tested maximum", () => {
    const negotiated = negotiateDockerApiVersion({ minApiVersion: "1.50", apiVersion: "1.55" });
    expect(negotiated.ok).toBe(false);
    if (negotiated.ok) throw new Error("expected negotiation to fail");
    expect(negotiated.ourRange).toBe("1.43-1.44");
    expect(negotiated.daemonRange).toBe("1.50-1.55");
    expect(negotiated.message).toContain("1.43-1.44");
    expect(negotiated.message).toContain("1.50-1.55");
  });

  test("honors DOCKER_API_VERSION when it stays inside the tested range", () => {
    expect(parseDockerApiVersionOverride("1.44")).toEqual({
      ok: true,
      version: "1.44",
      prefix: "/v1.44",
    });
    expect(parseDockerApiVersionOverride("v1.43")).toEqual({
      ok: true,
      version: "1.43",
      prefix: "/v1.43",
    });
  });

  test("rejects DOCKER_API_VERSION values above the tested maximum", () => {
    const parsed = parseDockerApiVersionOverride("1.51");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected override to fail");
    expect(parsed.message).toContain("1.51");
    expect(parsed.message).toContain("1.43-1.44");
  });

  test("extracts daemon range from headers, JSON, and 400 text", () => {
    expect(
      extractDockerDaemonApiRange({
        headers: { "Api-Version": "1.51", "Min-API-Version": "1.44" },
      }),
    ).toEqual({ apiVersion: "1.51", minApiVersion: "1.44" });
    expect(
      extractDockerDaemonApiRange({
        body: JSON.stringify({ ApiVersion: "1.45", MinAPIVersion: "1.24" }),
      }),
    ).toEqual({ apiVersion: "1.45", minApiVersion: "1.24" });
    expect(
      extractDockerDaemonApiRange({
        body: '{"message":"client version 1.43 is too old. Minimum supported API version is 1.44"}',
      }),
    ).toEqual({ minApiVersion: "1.44" });
  });

  test("formats open and closed ranges for error text", () => {
    expect(formatDockerApiRange("1.43", "1.44")).toBe("1.43-1.44");
    expect(formatDockerApiRange("1.44", "1.44")).toBe("1.44");
    expect(formatDockerApiRange("1.50")).toBe("1.50+");
    expect(formatDockerApiRange(undefined, "1.41")).toBe("up to 1.41");
    expect(formatDockerApiRange()).toBe("unspecified");
  });
});
