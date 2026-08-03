import { describe, expect, test } from "bun:test";

const CHECK_MODULE_PATH = "../../../scripts/check-schema-compatibility.ts";
const CLASSIFIER_MODULE_PATH = "../../../scripts/schema-compatibility/classifier.ts";

type JsonSchema = Readonly<Record<string, unknown>>;

interface CompatibilityException {
  readonly surface: string;
  readonly changeKind: string;
  readonly path: string;
  readonly justification: string;
}

const callExport = async (path: string, name: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
  const module: unknown = await import(path);
  if (module === null || typeof module !== "object" || !(name in module)) {
    throw new TypeError(`${path} does not export ${name}`);
  }
  const exported: unknown = Reflect.get(module, name);
  if (typeof exported !== "function") throw new TypeError(`${path} does not export ${name}`);
  return Reflect.apply(exported, undefined, args);
};

const skippedFamilyNotices = async (...args: ReadonlyArray<unknown>): Promise<unknown> => {
  return callExport(CHECK_MODULE_PATH, "skippedFamilyNotices", args);
};

const classifySchemaChange = (before: JsonSchema, after: JsonSchema, polarity: string): Promise<unknown> =>
  callExport(CLASSIFIER_MODULE_PATH, "classifySchemaChange", [before, after, polarity]);

const acceptCompatibilityExceptions = (
  surface: string,
  findings: unknown,
  exceptions: ReadonlyArray<CompatibilityException>,
): Promise<unknown> =>
  callExport(CLASSIFIER_MODULE_PATH, "acceptCompatibilityExceptions", [surface, findings, exceptions]);

const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: ReadonlyArray<string> = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("schema compatibility classifier", () => {
  test("classifies an optional input property addition as compatible", async () => {
    const before = objectSchema({ name: { type: "string" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name"]);

    const findings = await classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "compatible", changeKind: "property-added", path: "$.port" }),
    ]);
  });

  test("classifies a required input property addition as breaking", async () => {
    const before = objectSchema({ name: { type: "string" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name", "port"]);

    const findings = await classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-added", path: "$.port" }),
    ]);
  });

  test("classifies an output property removal as breaking", async () => {
    const before = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" } }, ["name"]);

    const findings = await classifySchemaChange(before, after, "output");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-removed", path: "$.port" }),
    ]);
  });

  test("classifies an input enum narrowing as breaking", async () => {
    const findings = await classifySchemaChange(
      { type: "string", enum: ["alpha", "beta"] },
      { type: "string", enum: ["alpha"] },
      "input",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "enum-narrowed", path: "$" }),
    ]);
  });

  test("classifies an input enum widening as compatible", async () => {
    const findings = await classifySchemaChange(
      { type: "string", enum: ["alpha"] },
      { type: "string", enum: ["alpha", "beta"] },
      "input",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "compatible", changeKind: "enum-widened", path: "$" }),
    ]);
  });

  test("classifies optional to required on an input as breaking", async () => {
    const before = objectSchema({ port: { type: "number" } });
    const after = objectSchema({ port: { type: "number" } }, ["port"]);

    const findings = await classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-required", path: "$.port" }),
    ]);
  });

  test("classifies a changed union construct as unknown", async () => {
    const findings = await classifySchemaChange(
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { oneOf: [{ type: "string" }, { type: "boolean" }] },
      "strict",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "unknown", changeKind: "unsupported-construct", path: "$.oneOf" }),
    ]);
  });

  test("accepts only the exact breaking finding named by an exception", async () => {
    const findings = await classifySchemaChange(
      objectSchema({ name: { type: "string" }, port: { type: "number" } }),
      objectSchema({ name: { type: "string" } }),
      "output",
    );
    const exceptions: ReadonlyArray<CompatibilityException> = [
      {
        surface: "command:app:info",
        changeKind: "property-removed",
        path: "$.port",
        justification: "The command never populated this pre-release field.",
      },
    ];

    const accepted = await acceptCompatibilityExceptions("command:app:info", findings, exceptions);

    expect(accepted).toEqual([
      expect.objectContaining({ accepted: true, justification: exceptions[0]?.justification }),
    ]);
  });

  test("counts every current surface skipped when a base artifact family is unavailable", async () => {
    const schema = objectSchema({ name: { type: "string" } });
    const artifacts = new Map([
      ["schema:Config", { surface: "schema:Config", polarity: "input" as const, schema }],
      ["command:app:info", { surface: "command:app:info", polarity: "output" as const, schema }],
      ["command:app:list", { surface: "command:app:list", polarity: "output" as const, schema }],
    ]);

    const notices = await skippedFamilyNotices(artifacts, "origin/main", ["command"]);

    expect(notices).toEqual([
      {
        family: "command",
        count: 2,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: "origin/main",
      },
    ]);
  });
});
