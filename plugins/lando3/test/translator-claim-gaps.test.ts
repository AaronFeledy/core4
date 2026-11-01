import { expect, test } from "bun:test";
import { Effect } from "effect";
import { isResidualDiagnostic } from "../src/claims.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

const translate = (text: string) =>
  Effect.runPromise(makeTestTranslator().translate(documentSet([document(".lando.yml", text)])));

test.each([
  ["via", "nginx", "php"],
  ["xdebug", "true", "php"],
  ["composer_version", "false", "php"],
  ["composer", "{vendor: tool}", "php"],
  ["db_client", "mysql", "php"],
  ["authentication", "native", "mysql"],
  ["globals", "{yarn: latest}", "node"],
  ["password", "secret", "redis"],
  ["persist", "true", "redis"],
  ["core", "search", "solr"],
  ["mailFrom", "[web]", "mailpit"],
  ["hogfrom", "[web]", "mailhog"],
  ["maxMessages", "100", "mailpit"],
  ["hosts", "[db]", "phpmyadmin"],
  ["backends", "[web]", "varnish"],
  ["backend", "web", "varnish"],
  ["backend_port", "8080", "varnish"],
])("drops foreign catalog option %s and names its owning type", async (key, value, owner) => {
  // Given an option authored on a catalog type that never consumed it in Lando 3.
  const type = owner === "node" ? "redis:7" : "node:22";
  // When translating the real document.
  const result = await translate(`services: {s: {type: ${type}, ${key}: ${value}}}`);
  // Then its whole value has one deliberate disposition, not a residual omission.
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ kind: "dropped", keyPath: ["services", "s", key] });
  expect(result.diagnostics[0]?.message).toContain(owner);
  expect(result.diagnostics[0]?.message.startsWith("Unclaimed")).toBe(false);
});

test.each([
  ["ssl: true", 443, true],
  ["ssl: true, sport: 8443", 8443, true],
  ["ssl: true, sslExpose: true", 443, true],
  ["ssl: true, sport: 8443, sslExpose: true", 8443, true],
  ["ssl: true, sslExpose: false", 443, false],
  ["ssl: true, sport: 8443, sslExpose: false", 8443, false],
] as const)("preserves certificates and explains SSL exposure for %s", async (fields, port, exposed) => {
  // Given the effective Lando 3 SSL defaults and an optional authored override.
  const text = `services: {s: {type: nginx, ${fields}}}`;
  // When converting without inventing a TLS listener.
  const result = await translate(text);
  // Then only certificates are mapped; publication gets an actionable review.
  expect(result.outputs[0]?.fragment).toHaveProperty("services.s", { type: "nginx", certs: true });
  expect(result.diagnostics).toHaveLength(exposed ? 1 : 0);
  if (exposed) {
    expect(result.diagnostics[0]).toMatchObject({ kind: "needs-review", keyPath: ["services", "s", "ssl"] });
    expect(result.diagnostics[0]?.message).toContain(`container port ${port}`);
    expect(result.diagnostics[0]?.message).toContain("TLS listener");
  }
});

test.each(["ssl: false, sport: 8443", "sport: 8443", "sslExpose: true", "ssl: false, sslExpose: false"])(
  "drops inert SSL settings without enabling certificates for %s",
  async (fields) => {
    // Given SSL is absent or falsy.
    const text = `services: {s: {type: nginx, ${fields}}}`;
    // When converting the no-op exposure or port.
    const result = await translate(text);
    // Then there is no certificate output and the ignored option is explained once.
    expect(result.outputs[0]?.fragment).toHaveProperty("services.s", {
      type: "nginx",
      ...(fields.includes("ssl: false") ? { certs: false } : {}),
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("dropped");
    expect(result.diagnostics[0]?.message.startsWith("Unclaimed")).toBe(false);
  },
);

test.each(["api: 4, image: alpine", "type: compose, services: {image: alpine}"])(
  "diagnoses commandless true healthchecks for %s",
  async (fields) => {
    // Given a true healthcheck that Lando 3 filtered out without running a command.
    const text = `services: {s: {${fields}, healthcheck: true}}`;
    // When converting.
    const result = await translate(text);
    // Then no readiness is manufactured and the omission is explicit.
    expect(result.outputs[0]?.fragment).not.toHaveProperty("services.s.readiness");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "dropped", keyPath: ["services", "s", "healthcheck"] }),
    );
  },
);

test("silently accepts disabled image SSH and accounts for catalog user once", async () => {
  // Given two previously ambiguous/no-op inputs.
  const text =
    "services: {s: {api: 4, image: {dockerfile: Dockerfile, ssh: false}}, db: {type: redis:7, user: root}}";
  // When converting both services.
  const result = await translate(text);
  // Then only the Dockerfile spelling requires a diagnostic.
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db.user", "root");
  expect(result.diagnostics.map(({ keyPath }) => keyPath)).toEqual([
    ["services", "s", "image", "dockerfile"],
  ]);
});

test("promotes only the last l337 app-root bind and keeps no default app mount", async () => {
  // Given the bare base service and two binds of the app root.
  const text =
    "services: {s: {api: 4, type: l337, image: alpine, volumes: ['.:/first', './:/src'], healthcheck: echo ignored}, bare: {api: 4, type: l337, image: alpine}}";
  // When converting without the Lando service stack.
  const result = await translate(text);
  // Then the last bind becomes appMount once, earlier binds remain, and home is not inferred.
  expect(result.outputs[0]?.fragment).toHaveProperty("services.s", {
    type: "compose",
    image: "alpine",
    appMount: { target: "/src" },
    volumes: [".:/first"],
  });
  expect(result.outputs[0]?.fragment).toHaveProperty("services.bare", {
    type: "compose",
    image: "alpine",
    appMount: false,
  });
  expect(result.expectations ?? []).toEqual([]);
  expect(result.diagnostics.map(({ kind, keyPath }) => [kind, keyPath])).toEqual([
    ["dropped", ["services", "s", "healthcheck"]],
  ]);
});

test("diagnoses an atomic l337 volume mapping rather than silently omitting it", async () => {
  // Given a modeled but non-list Compose volume value.
  const text = "services: {s: {api: 4, type: l337, image: alpine, volumes: {}}}";
  // When the l337 projection cannot preserve the mapping as a mount list.
  const result = await translate(text);
  // Then one deliberate disposition accounts for the atomic empty collection.
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "dropped",
      keyPath: ["services", "s", "volumes"],
    }),
  );
});

test.each([
  ["ssl: 4444", { _tag: "published", protocol: "https", port: 4444, publication: {} }],
  ["ssl: 4444, sslExpose: false", { _tag: "internal", protocol: "https", port: 4444 }],
])("treats a numeric node %s as the port its app serves HTTPS on", async (fields, endpoint) => {
  // Given
  const text = `services: {web: {type: "node:22", ${fields}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toMatchObject({
    services: { web: { certs: true, endpoints: [endpoint] } },
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ kind: "rewritten", keyPath: ["services", "web", "ssl"] }),
  );
  expect(result.diagnostics.filter(isResidualDiagnostic)).toEqual([]);
});

test("keeps Lando 3's 443 fallback for a quoted node ssl port", async () => {
  // Given: Lando 3's node plugin only accepted an integer ssl as the HTTPS port
  const text = 'services: {web: {type: "node:22", ssl: "4444"}}';
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toMatchObject({ services: { web: { certs: true } } });
  expect(result.outputs[0]?.fragment).not.toMatchObject({
    services: { web: { endpoints: expect.anything() } },
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "needs-review",
      keyPath: ["services", "web", "ssl"],
      message: expect.stringContaining("container port 443"),
    }),
  );
});
