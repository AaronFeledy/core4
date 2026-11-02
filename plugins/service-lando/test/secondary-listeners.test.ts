import { describe, expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const plan = (definition: Record<string, unknown>) => {
  const service = Schema.decodeUnknownSync(ServiceConfig)(definition);
  const serviceType = serviceTypes.get(service.type ?? "");
  if (serviceType === undefined) throw new Error("Missing fixture service type");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/secondary-listeners",
    metadata: { resolvedAt: "2026-11-01T00:00:00Z", source: "secondary-listeners", runtime: 4 },
  });
};

describe("LocalStack DNS listener", () => {
  test.each([
    { port: 53 },
    { port: 1053, environment: { DNS_PORT: "1053" } },
    { port: 53, environment: { DNS_ADDRESS: "00" } },
    { port: 53, environment: { DNS_ADDRESS: "0.0.0.0" } },
    { port: 53, endpoints: [] },
  ])("rejects a primary collision with effective DNS: %j", async (definition) => {
    // Given / When / Then
    await expect(plan({ type: "localstack", ...definition })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["port"], message: expect.stringContaining("DNS server") })],
    });
  });

  test.each([{ DNS_ADDRESS: "0" }, { DNS_PORT: "1053" }])(
    "releases 53 when DNS is disabled or moved: %j",
    async (environment) => {
      // Given / When
      const result = await plan({ type: "localstack", port: 53, environment });
      // Then
      expect(result.endpoints).toContainEqual(expect.objectContaining({ port: 53, primary: true }));
      expect(result.environment).toMatchObject(environment);
    },
  );

  test.each([
    { GATEWAY_LISTEN: "0.0.0.0:4566,0.0.0.0:53" },
    { GATEWAY_LISTEN: "0.0.0.0:4566,0.0.0.0:1053", DNS_PORT: "1053" },
  ])("rejects an extra gateway on effective DNS: %j", async (environment) => {
    // Given / When / Then
    await expect(plan({ type: "localstack", environment })).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          path: ["environment", "GATEWAY_LISTEN"],
          message: expect.stringContaining("DNS server"),
        }),
      ],
    });
  });

  test("releases 53 for an extra gateway when DNS is disabled", async () => {
    // Given / When
    const result = await plan({
      type: "localstack",
      environment: { DNS_ADDRESS: "0", GATEWAY_LISTEN: "0.0.0.0:4566,0.0.0.0:53" },
    });
    // Then
    expect(result.endpoints).toContainEqual({
      _tag: "internal",
      port: 53,
      protocol: "http",
      name: "gateway-53",
    });
  });

  for (const address of ["0", "0.0.0.0"]) {
    test.each(["", "0", "65536", "-1", "1.5", "53-54", "dns", { _tag: "SecretRef", reference: "DNS" }])(
      `rejects malformed DNS_PORT %j with DNS_ADDRESS=${address}`,
      async (port) => {
        // Given / When / Then
        await expect(
          plan({ type: "localstack", environment: { DNS_ADDRESS: address, DNS_PORT: port } }),
        ).rejects.toMatchObject({
          issues: [expect.objectContaining({ path: ["environment", "DNS_PORT"] })],
        });
      },
    );
  }
});

describe("Solr stop listener", () => {
  test.each([1, 999, 1000])("rejects invalid derived STOP_PORT when port is %i", async (port) => {
    // Given / When / Then
    await expect(plan({ type: "solr", port })).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          path: ["port"],
          message: expect.stringContaining(`STOP_PORT ${port - 1000}`),
          suggestion: expect.stringContaining("STOP_PORT"),
        }),
      ],
    });
  });

  test.each([1001, 7983, 65535])("allows a valid derived stop port when primary is %i", async (port) => {
    // Given / When
    const result = await plan({ type: "solr", port });
    // Then
    expect(result.command).toEqual(["solr-foreground", "-p", String(port)]);
  });

  test.each([80, 999, 1000])("allows low primary %i with an explicit valid stop port", async (port) => {
    // Given / When
    const result = await plan({ type: "solr", port, environment: { STOP_PORT: "18000" } });
    // Then
    expect(result.command).toEqual(["solr-foreground", "-p", String(port)]);
    expect(result.environment.STOP_PORT).toBe("18000");
  });

  test("rejects a primary collision with an authored stop port", async () => {
    // Given / When / Then
    await expect(plan({ type: "solr", environment: { STOP_PORT: "8983" } })).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ path: ["port"], message: expect.stringContaining("stop listener") }),
      ],
    });
  });

  test.each(["", "0", "-1", "65536", "1.5", "7983-7984", { _tag: "SecretRef", reference: "STOP" }])(
    "rejects invalid authored STOP_PORT %j",
    async (stopPort) => {
      // Given / When / Then
      await expect(plan({ type: "solr", environment: { STOP_PORT: stopPort } })).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ["environment", "STOP_PORT"] })],
      });
    },
  );

  test("leaves stop-listener configuration to an authored command", async () => {
    // Given / When
    const result = await plan({ type: "solr", port: 80, command: ["custom-solr"] });
    // Then
    expect(result.command).toEqual(["custom-solr"]);
  });
});
