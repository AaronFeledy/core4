import { expect, test } from "bun:test";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { lowerBuildHooks } from "../src/build-hooks.ts";
import { ClaimCursor } from "../src/claims.ts";
import { lowerComposeFields } from "../src/compose-fields.ts";
import { lowerApi4Service } from "../src/lower-api4.ts";
import { lowerTypeOptions } from "../src/lower-type-options.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator, testPorts } from "./fixtures/test-ports.ts";

const ctx: ServiceLoweringContext = {
  serviceFacts: testPorts().serviceFacts,
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

test.each([
  ["5173:5173/http", "http", 5173, { hostPort: 5173 }],
  ["8443:443/https", "https", 443, { hostPort: 8443 }],
  ["9000:80/tcp", "tcp", 80, { hostPort: 9000 }],
  ["0:80/http", "http", 80, {}],
  ["8080/http", "http", 8080, {}],
  ["8443/https", "https", 8443, {}],
  ["127.0.0.1:8443:443/https", "https", 443, { bindAddress: "127.0.0.1", hostPort: 8443 }],
  ["[::1]:0:80/http", "http", 80, { bindAddress: "::1" }],
] as const)(
  "preserves API-4 publication and protocol when ports contains %s",
  (port, protocol, target, publication) => {
    // Given
    const service = { ports: [port] };
    const cursor = new ClaimCursor(service, ctx);
    // When
    const result = lowerApi4Service(service, { ...ctx, cursor });
    // Then
    expect(result.patch.endpoints).toEqual([{ _tag: "published", protocol, port: target, publication }]);
    expect(result.patch).not.toHaveProperty("ports");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "rewritten" }));
    expect(cursor.residuals(result.diagnostics)).toEqual([]);
  },
);

test.each([
  ["0:80", "80"],
  ["0:53/udp", "53/udp"],
  ["127.0.0.1:0:80/tcp", "127.0.0.1::80/tcp"],
  [
    { target: 80, published: "0", host_ip: "127.0.0.1" },
    { target: 80, host_ip: "127.0.0.1" },
  ],
  [
    { target: 53, published: 0, protocol: "udp" },
    { target: 53, protocol: "udp" },
  ],
])("preserves random Compose publication when ports contains %j", (port, expected) => {
  // Given
  const service = { ports: [port] };
  const cursor = new ClaimCursor(service, ctx);
  // When
  const result = lowerComposeFields(service, { ...ctx, cursor }, { basePath: [] });
  // Then
  expect(result.patch.ports).toEqual([expected]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "rewritten" }));
  expect(cursor.residuals(result.diagnostics)).toEqual([]);
});

test("blocks image builds with app hooks when the target cannot represent both families", () => {
  // Given
  const service = { api: 4, image: { imagefile: "FROM alpine:3.21" }, build: { app: "echo ready" } };
  // When
  const result = lowerBuildHooks(service, ctx, {});
  // Then
  expect(result.blocked).toBe(true);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ kind: "unsupported", keyPath: [...ctx.keyPath, "build"] }),
  );
});

test("materializes the implicit Varnish backend when none is authored", () => {
  // Given
  const service = { type: "varnish:6" };
  // When
  const result = lowerTypeOptions("varnish", service, ctx);
  // Then
  expect(result.patch.backend).toBe("appserver");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "rewritten" }));
});

test.each([
  [
    "api: 4, type: lando, image: alpine:3.21, ports: ['5173:5173/http']",
    "endpoints",
    [{ _tag: "published", protocol: "http", port: 5173, publication: { hostPort: 5173 } }],
  ],
  ["type: lando, services: {image: alpine:3.21, ports: ['0:80']}", "ports", ["80"]],
  ["type: compose, services: {image: alpine:3.21, ports: ['0:80']}", "ports", ["80"]],
  ["type: lando, services: {image: alpine:3.21}, overrides: {ports: ['0:80']}", "ports", ["80"]],
  ["type: varnish:6", "backend", "appserver"],
] as const)("translates the whole document faithfully when service is %s", async (fields, key, expected) => {
  // Given
  const translator = makeTestTranslator();
  const input = documentSet([document(".lando.yml", `name: fidelity\nservices: {web: {${fields}}}`)]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty(`services.web.${key}`, expected);
  for (const { fragment } of result.outputs) Schema.decodeUnknownSync(LandofileAuthoringFragment)(fragment);
  expect(result.diagnostics.filter(({ message }) => message.startsWith("Unclaimed"))).toEqual([]);
  expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
});

test("omits an unrepresentable service with one unsupported build diagnostic when imagefile and app hooks coexist", async () => {
  // Given
  const translator = makeTestTranslator();
  const input = documentSet([
    document(
      ".lando.yml",
      "name: fidelity\nservices: {web: {api: 4, type: lando, image: {imagefile: 'FROM alpine:3.21'}, build: {app: 'echo ready'}}}",
    ),
  ]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs[0]?.fragment).not.toHaveProperty("services.web");
  expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([
    expect.objectContaining({ keyPath: [...ctx.keyPath, "build"] }),
  ]);
  expect(result.diagnostics.filter(({ message }) => message.startsWith("Unclaimed"))).toEqual([]);
});
