import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  LandofileAuthoringShape,
  getEditorJsonSchema,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect";
import { importableNode } from "./landofile-parity-json-schema-fixup.ts";

test.each(["LandofileShape", "GlobalConfig"] as const)("emits closed draft-07 %s editor schemas", (name) => {
  const artifact = getEditorJsonSchema(name);

  expect(artifact).toMatchObject({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    type: "object",
    additionalProperties: false,
  });
  expect(artifact).toHaveProperty("definitions");
  expect(artifact).not.toHaveProperty("$defs");
  expect(JSON.stringify(artifact)).not.toContain("#/$defs/");
});

test("preserves Landofile extension slots and descriptions in the editor projection", () => {
  const artifact = getEditorJsonSchema("LandofileShape");

  expect(artifact).toHaveProperty(["patternProperties", "^x-"]);
  expect(artifact).not.toHaveProperty("propertyNames");
  expect(artifact).toHaveProperty("properties.name.anyOf.0.description", expect.any(String));
  // Service config may be a local $ref or an inlined closed object after Compose-key canonicalization.
  const serviceValue =
    (
      artifact as {
        properties?: { services?: { anyOf?: Array<{ additionalProperties?: { anyOf?: unknown[] } }> } };
      }
    ).properties?.services?.anyOf?.[0]?.additionalProperties?.anyOf?.[0] ??
    (artifact as { properties?: { services?: { anyOf?: Array<{ additionalProperties?: unknown }> } } })
      .properties?.services?.anyOf?.[0]?.additionalProperties;
  expect(serviceValue).toBeDefined();
  if (serviceValue && typeof serviceValue === "object" && "$ref" in serviceValue) {
    expect(String((serviceValue as { $ref: string }).$ref)).toMatch(/^#\/definitions\//);
  } else {
    expect(serviceValue).toEqual(expect.objectContaining({ type: "object" }));
  }
});

test("publishes native merge directive tags without widening Landofile fields", () => {
  // Given the Landofile editor projection.
  const artifact = getEditorJsonSchema("LandofileShape");

  // Then the informational tag registry names both directives and every YAML node kind.
  for (const tag of ["!override", "!reset"])
    expect(artifact).toHaveProperty(["x-lando-yaml-tags", tag, "kinds"], ["scalar", "sequence", "mapping"]);
  expect(getEditorJsonSchema("GlobalConfig")).not.toHaveProperty("x-lando-yaml-tags");
  // And no field schema admits the internal directive brand or wire envelope.
  const text = JSON.stringify({ ...artifact, "x-lando-yaml-tags": undefined });
  expect(text).not.toContain("LandofileReset");
  expect(text).not.toContain("LandofileOverride");
  expect(text).not.toContain("merge-directive");
});

const editorAuthoring = Schema.make<Schema.Codec<unknown>>(
  SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape")),
    { patterns: "apply", onEnter: importableNode },
  ).ast,
);

test.each([
  [true, true],
  [false, true],
  ["TrUe", true],
  ["oFf", true],
  ["YeS", true],
  ["nO", true],
  ["1", true],
  ["0", true],
  ["{{ vars.init }}", true],
  ["{{ boolean(env.INIT) }}", true],
  ["prefix{{ vars.init }}suffix", true],
  ["{{- vars.init -}}", true],
  ["{{ vars.init }}{{ env.INIT }}", true],
  ["{{# comment #}}{{ vars.init }}", true],
  ["${INIT}", true],
  ["${INIT:-false}", true],
  ["${INIT-false}", true],
  ["$INIT", true],
  ["${secret:INIT}", true],
  ["${secret:init-flag}", true],
  ["$${LITERAL}{{ vars.init }}", true],
  ["sometimes", false],
  [" true", false],
  ["false ", false],
  ["true\n", false],
  ["$${INIT}", false],
  ["{{{{ vars.init }}", false],
  ["{{# comment #}}", false],
  ["", false],
  [1, false],
  [null, false],
] as const)("editor init acceptance matches authoring for %j", (init, accepted) => {
  // Given
  const input = { name: "demo", services: { web: { init } } };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  // When
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  const authoring = Schema.decodeUnknownResult(LandofileAuthoringShape)(input, options);
  // Then
  expect(Result.isSuccess(authoring)).toBe(accepted);
  expect(Result.isSuccess(editor)).toBe(accepted);
  if (Result.isFailure(authoring)) {
    expect(
      validationIssuesFromSchemaIssue(authoring.failure.issue).map((issue) => issue.path),
    ).toContainEqual(["services", "web", "init"]);
  }
});

test("bounds repeated-comment validation and still accepts a following expression", async () => {
  // Given comment-only input and the same prefix followed by a legitimate expression.
  const script = `
    import { getEditorJsonSchema } from "@lando/sdk/schema";
    import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect";
    import { importableNode } from ${JSON.stringify(new URL("./landofile-parity-json-schema-fixup.ts", import.meta.url).href)};
    const editor = Schema.make(SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape")),
      { patterns: "apply", onEnter: importableNode },
    ).ast);
    const prefix = "{{# x #}}".repeat(1000);
    for (let index = 0; index < 8; index++) {
      for (const [suffix, accepted] of [["", false], ["{{ vars.init }}", true]]) {
        const result = Schema.decodeUnknownResult(editor)({ name: "demo", services: { web: { init: prefix + suffix } } });
        if (Result.isSuccess(result) !== accepted) process.exit(1);
      }
    }
    process.stdout.write("16");
  `;
  // When the real editor decoder runs in a child with a generous hard deadline.
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Then both outcomes complete without runaway backtracking or lost acceptance.
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "16", stderr: "" });
}, 10_000);

test.each([
  { endpoints: ["http:80"], accepted: true },
  { endpoints: ["ui=https:443"], accepted: true },
  { endpoints: [{ kind: "internal", protocol: "http", port: 80 }], accepted: true },
  { endpoints: [{ kind: "published", protocol: "tcp", port: 53, publication: {} }], accepted: true },
  { endpoints: ["{{ env.EP }}"], accepted: true },
  { endpoints: [{ kind: "internal", protocol: "http", port: "{{ number(env.PORT) }}" }], accepted: true },
  { endpoints: ["http:0"], accepted: false },
  { endpoints: ["${EP}"], accepted: true },
  { endpoints: ["http:{{ env.PORT }}"], accepted: true },
  { endpoints: [{ _tag: "internal", protocol: "http", port: 80 }], accepted: false },
  { endpoints: [{ kind: "internal", _tag: "internal", protocol: "http", port: 80 }], accepted: false },
] as const)("editor endpoint acceptance matches authoring for %j", ({ endpoints, accepted }) => {
  // Given
  const input = { name: "demo", services: { web: { endpoints: [...endpoints] } } };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  // When
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  const authoring = Schema.decodeUnknownResult(LandofileAuthoringShape)(input, options);
  // Then
  expect(Result.isSuccess(authoring)).toBe(accepted);
  expect(Result.isSuccess(editor)).toBe(accepted);
  if (!accepted && Result.isFailure(authoring)) {
    const paths = validationIssuesFromSchemaIssue(authoring.failure.issue).map((issue) => issue.path);
    expect(
      paths.some(
        (path) => path[0] === "services" && path[1] === "web" && path[2] === "endpoints" && path[3] === 0,
      ),
    ).toBe(true);
  }
});

test.each([
  { filters: [{ kind: "stripPrefix", prefix: "/api" }], accepted: true },
  { filters: [{ type: "stripPrefix", prefix: "/api" }], accepted: false },
  { filters: [{ kind: "stripPrefix", type: "stripPrefix", prefix: "/api" }], accepted: false },
] as const)("editor route filter kind acceptance matches authoring for %j", ({ filters, accepted }) => {
  const input = {
    name: "demo",
    services: { web: { routes: [{ hostname: "app.test", filters: [...filters] }] } },
  };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  const authoring = Schema.decodeUnknownResult(LandofileAuthoringShape)(input, options);
  expect(Result.isSuccess(authoring)).toBe(accepted);
  expect(Result.isSuccess(editor)).toBe(accepted);
});

test("drops decoded-only descriptor object branches from the editor input document", () => {
  // Given the Landofile editor projection used by YAML editors and Standard JSON Schema input.
  const artifact = getEditorJsonSchema("LandofileShape");
  const definitions = artifact.definitions;
  expect(definitions).toBeDefined();
  // Then no SecretRef / BoundText / RouteText / ImportRef authoring object definitions remain.
  const descriptorKeys = Object.keys(definitions ?? {}).filter((key) =>
    /^(?:SecretRef|BoundText(?:Reference)?|RouteText|RouteUrlPart|StringImportRef)Authoring(?:_\d+)?$/u.test(
      key,
    ),
  );
  expect(descriptorKeys).toEqual([]);
  const text = JSON.stringify(artifact);
  expect(text).not.toContain("#/definitions/SecretRefAuthoring");
  expect(text).not.toContain("#/definitions/BoundTextAuthoring");
  expect(text).not.toContain("#/definitions/RouteTextAuthoring");
  expect(text).not.toContain("#/definitions/StringImportRefAuthoring");
  expect(text).not.toMatch(/"enum"\s*:\s*\[\s*"ImportRef"\s*\]/u);
  expect(text).not.toMatch(/"enum"\s*:\s*\[\s*"SecretRef"\s*\]/u);
  expect(text).not.toMatch(/"enum"\s*:\s*\[\s*"BoundText"\s*\]/u);
  expect(text).not.toMatch(/"enum"\s*:\s*\[\s*"RouteText"\s*\]/u);
});

test.each([
  ["SecretRef object", { web: { environment: { TOKEN: { _tag: "SecretRef", reference: "TOKEN" } } } }],
  [
    "BoundText object",
    {
      web: {
        environment: {
          URL: { _tag: "BoundText", parts: ["x", { reference: "TOKEN", encoding: "raw" as const }] },
        },
      },
    },
  ],
  [
    "RouteText object",
    {
      web: {
        environment: {
          HOME: { _tag: "RouteText", parts: [{ service: "web", encoding: "raw" as const }] },
        },
      },
    },
  ],
  [
    "ImportRef object",
    {
      web: {
        security: {
          ca: [
            {
              _tag: "ImportRef" as const,
              path: "ca.pem",
              basename: "ca.pem",
              checksum: "abc",
              layer: "canonical" as const,
              value: "pem",
            },
          ],
        },
      },
    },
  ],
] as const)("editor input rejects decoded-only %s", (_label, services) => {
  // Given a Landofile that uses a decoded runtime descriptor object instead of authored syntax.
  const input = { name: "demo", services };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  // When the editor document is applied as a decoder.
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  // Then the decoded-only object branch is refused; authored strings remain accepted elsewhere.
  expect(Result.isSuccess(editor)).toBe(false);
});

test.each([
  ["secret string", { web: { environment: { TOKEN: "${secret:TOKEN}" } } }],
  ["ca path string", { web: { security: { ca: ["certs/ca.pem"] } } }],
] as const)("editor input still accepts authored %s", (_label, services) => {
  const input = { name: "demo", services };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  expect(Result.isSuccess(editor)).toBe(true);
});

test("publishes condition descriptions that say when if and when are checked", () => {
  // Given the editor projection for Landofile conditions.
  const artifact = getEditorJsonSchema("LandofileShape");
  const text = JSON.stringify(artifact);
  // Then event-step `if` describes invocation-time checking (lifecycle and tooling steps).
  expect(text).toContain("invocation time");
  expect(artifact).toHaveProperty(
    ["definitions", "EventCmdStepAuthoring", "properties", "if"],
    expect.objectContaining({
      description: expect.stringMatching(/invocation time/u),
    }),
  );
  // And include `when` describes load-time checking over recipe and env.
  expect(text).toContain("Landofile load time");
  expect(text).toContain("recipe and env");
});
