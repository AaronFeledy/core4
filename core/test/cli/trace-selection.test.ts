import { expect, test } from "bun:test";
import { resolveTrace } from "../../src/cli/trace-selection";

test("strips --trace only before the argument terminator", () => {
  const selected = resolveTrace({ argv: ["info", "--trace", "--", "--trace"], env: {} });
  expect(selected.remainingArgv).toEqual(["info", "--", "--trace"]);
  expect(selected.enabled).toBe(true);
  expect(selected.display).toBe(true);
});

test("enables local tracing from the injectable environment only for 1 or true", () => {
  for (const value of ["1", "true"]) expect(resolveTrace({ env: { LANDO_TRACE: value } }).display).toBe(true);
  for (const value of ["0", "false", ""])
    expect(resolveTrace({ env: { LANDO_TRACE: value } }).enabled).toBe(false);
});

test("selects exporter fields independently and decodes OTel header values", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://env.invalid",
    OTEL_EXPORTER_OTLP_HEADERS: " team = acme%20org , authorization=Bearer%20canary%3D669",
  };
  const configuredEndpoint = resolveTrace({ env, config: { otlp: { endpoint: "http://config.invalid" } } });
  expect(configuredEndpoint.endpoint).toBe("http://config.invalid");
  expect(configuredEndpoint.headers).toEqual({ team: "acme org", authorization: "Bearer canary=669" });
  expect(configuredEndpoint.display).toBe(false);
  expect(configuredEndpoint.enabled).toBe(true);
  const configuredHeaders = resolveTrace({ env, config: { otlp: { headers: {} } } });
  expect(configuredHeaders.endpoint).toBe("http://env.invalid");
  expect(configuredHeaders.headers).toEqual({});
});

test("leaves tracing disabled when only exporter headers are configured", () => {
  expect(resolveTrace({ env: { OTEL_EXPORTER_OTLP_HEADERS: "team=acme" } }).enabled).toBe(false);
});
