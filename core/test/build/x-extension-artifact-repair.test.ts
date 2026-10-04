import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

import {
  type CompatibilityException,
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";
import { type JsonSchema, isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import {
  CLOSED_EXTENSION_JUSTIFICATION,
  CONFIG_COMMANDS,
  EXTENSION_PATTERN,
  FIXTURE_PATH,
  NETWORK_SERVICE_CONFIGS,
  REPO_ROOT,
  admitsDeclaredName,
  admitsExtensionKey,
  blankContextBody,
  exceptionKey,
  expectedClosedExtensionExceptions,
  loadNormalizedArtifact,
  parseCapturedExtension,
  repairClosedExtension,
  schemaAt,
} from "./x-extension-closed-record.ts";
import { expectedWireExceptions } from "./x-extension-wire-proof.ts";

const captured = parseCapturedExtension(await Bun.file(FIXTURE_PATH).json());

const requireObject = (value: unknown, label: string): JsonSchema => {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
};

const repairedLandofile = (): JsonSchema =>
  normalizeJsonSchema(requireObject(repairClosedExtension(captured.landofile), "repaired landofile"));

describe("closed x-* extension artifact repair", () => {
  test("records the captured base artifact provenance", () => {
    expect(captured.provenanceCommit).toBe("15133ee26729942dde7b9d4f0e033b4ced46406d");
    expect(captured.pattern).toBe(EXTENSION_PATTERN);
  });

  test("repairs the captured landofile onto every current production embedding", async () => {
    // Given the normalized base landofile captured from commit 15133ee26.
    const repaired = repairedLandofile();
    const surfaces = [
      ...CONFIG_COMMANDS.map((command) => `command:${command}`),
      "schema:TemplateRenderContext",
    ];
    // When each current embedding is normalized with the lawful normalizer.
    for (const surface of surfaces) {
      const current = schemaAt(await loadNormalizedArtifact(surface), "$.landofile");
      // Then the whole subtree matches, including the nested service map.
      expect(jsonEquals(repaired, current)).toBe(true);
    }
    const shapeServices = schemaAt(await loadNormalizedArtifact("schema:LandofileShape"), "$.services");
    expect(jsonEquals(schemaAt(repaired, "$.services"), shapeServices)).toBe(true);
  });

  test("repairs the captured network map onto every current service schema", async () => {
    const repaired = normalizeJsonSchema(
      requireObject(repairClosedExtension(captured.networks), "repaired networks"),
    );
    for (const schemaId of NETWORK_SERVICE_CONFIGS) {
      const current = schemaAt(await loadNormalizedArtifact(`schema:${schemaId}`), "$.networks");
      expect(jsonEquals(repaired, current)).toBe(true);
    }
  });

  test("locks translator context keywords independently of the wire union proofs", async () => {
    const context = schemaAt(await loadNormalizedArtifact("schema:ConfigTranslateEncodeInput"), "$.context");
    expect(context.propertyNames).toBeUndefined();
    expect(context.additionalProperties).toBe(false);
    expect(context.patternProperties).toEqual({ [EXTENSION_PATTERN]: {} });
    const properties = requireObject(context.properties, "context properties");
    expect(Object.keys(properties).sort()).toEqual([...captured.contextPropertyKeys].sort());
    expect(
      createHash("sha256")
        .update(JSON.stringify(blankContextBody(context)))
        .digest("hex"),
    ).toBe(captured.contextBodySha256);
    const historical = { ...context, propertyNames: captured.contextPropertyNames };
    Reflect.deleteProperty(historical, "additionalProperties");
    Reflect.deleteProperty(historical, "patternProperties");
    const findings = classifySchemaChange(historical, context, "strict");
    expect(findings.map((finding) => finding.path).sort()).toEqual([
      "$.additionalProperties",
      "$.patternProperties",
      "$.propertyNames",
    ]);
    expect(findings.every((finding) => finding.accepted === false)).toBe(true);
  });

  test("shows the historical propertyNames pattern rejects a declared name", () => {
    const pattern = new RegExp(EXTENSION_PATTERN);
    expect(pattern.test("name")).toBe(false);
    expect(pattern.test("x-team")).toBe(true);
    expect(pattern.test("x-")).toBe(true);
    expect(pattern.test("x-\nmore")).toBe(true);
    expect(pattern.test("X-team")).toBe(false);
    expect(pattern.test("x_team")).toBe(false);
    expect(captured.contextPropertyNames).toEqual({ pattern: EXTENSION_PATTERN, type: "string" });
  });

  test("admits declared names and x- extensions on the current command schema", async () => {
    const landofile = schemaAt(await loadNormalizedArtifact("command:app:config"), "$.landofile");
    expect(admitsExtensionKey(landofile, "name")).toBe(true);
    expect(admitsDeclaredName(landofile, "myapp")).toBe(true);
    expect(admitsExtensionKey(landofile, "x-team")).toBe(true);
    expect(admitsExtensionKey(landofile, "x-")).toBe(true);
    expect(admitsExtensionKey(landofile, "x-\nmore")).toBe(true);
    expect(admitsExtensionKey(landofile, "other")).toBe(false);
    expect(admitsExtensionKey(landofile, "X-team")).toBe(false);
    expect(admitsExtensionKey(landofile, "x_team")).toBe(false);
    expect(admitsExtensionKey(landofile, "xteam")).toBe(false);
    expect(admitsDeclaredName(landofile, 42)).toBe(false);
  });

  test("keeps runtime key admission aligned with the repaired artifact", () => {
    const decode = Schema.decodeUnknownResult(LandofileShape);
    for (const key of ["x-team", "x-", "x-\nmore"]) {
      expect(
        Result.isSuccess(
          decode({ name: "myapp", [key]: { values: [null, 1, true] } }, { onExcessProperty: "error" }),
        ),
      ).toBe(true);
    }
    for (const key of ["other", "X-team", "x_team"]) {
      expect(Result.isFailure(decode({ name: "myapp", [key]: true }, { onExcessProperty: "error" }))).toBe(
        true,
      );
    }
    expect(Result.isFailure(decode({ name: 42 }, { onExcessProperty: "error" }))).toBe(true);
  });

  test("still flags the old artifact unless the exception path and surface match", async () => {
    const current = schemaAt(await loadNormalizedArtifact("command:app:config"), "$.landofile");
    const findings = classifySchemaChange(
      { type: "object", properties: { landofile: captured.landofile } },
      { type: "object", properties: { landofile: current } },
      "output",
    );
    expect(findings.map((finding) => `${finding.changeKind} ${finding.path}`).sort()).toEqual([
      "unsupported-keyword $.landofile.additionalProperties",
      "unsupported-keyword $.landofile.patternProperties",
      "unsupported-keyword $.landofile.propertyNames",
      "unsupported-keyword $.landofile.services.additionalProperties",
    ]);
    expect(findings.every((finding) => finding.accepted === false)).toBe(true);
    const exact: CompatibilityException = {
      surface: "command:app:config",
      changeKind: "unsupported-keyword",
      path: "$.landofile.propertyNames",
      justification: CLOSED_EXTENSION_JUSTIFICATION,
    };
    const accepted = acceptCompatibilityExceptions("command:app:config", findings, [exact]);
    expect(accepted.find((finding) => finding.path === "$.landofile.propertyNames")?.accepted).toBe(true);
    expect(
      accepted
        .filter((finding) => finding.path !== "$.landofile.propertyNames")
        .every((finding) => !finding.accepted),
    ).toBe(true);
    const wrongPath = acceptCompatibilityExceptions("command:app:config", findings, [
      { ...exact, path: "$.landofile.services.propertyNames" },
    ]);
    expect(wrongPath.every((finding) => finding.accepted === false)).toBe(true);
    const wrongSurface = acceptCompatibilityExceptions("command:app:config", findings, [
      { ...exact, surface: "command:app:missing" },
    ]);
    expect(wrongSurface.every((finding) => finding.accepted === false)).toBe(true);
    const networks = schemaAt(await loadNormalizedArtifact("schema:DotnetServiceConfig"), "$.networks");
    const networkFindings = classifySchemaChange(
      { type: "object", properties: { networks: captured.networks } },
      { type: "object", properties: { networks } },
      "strict",
    );
    expect(networkFindings.map((finding) => `${finding.changeKind} ${finding.path}`)).toEqual([
      "unsupported-construct $.networks.anyOf",
    ]);
    expect(networkFindings.every((finding) => finding.accepted === false)).toBe(true);
  });

  test("fails when an unrelated field in the repaired subtree changes", async () => {
    const repaired = repairedLandofile();
    const current = schemaAt(await loadNormalizedArtifact("command:app:config"), "$.landofile");
    expect(jsonEquals(repaired, current)).toBe(true);
    const properties = requireObject(current.properties, "properties");
    const mutated: JsonSchema = { ...current, properties: { ...properties, name: { type: "number" } } };
    expect(jsonEquals(repaired, mutated)).toBe(false);
  });

  test("does not repair a tighter propertyNames constraint", () => {
    const tighter: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      propertyNames: { type: "string", pattern: EXTENSION_PATTERN, minLength: 4 },
    };
    const closed: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
      patternProperties: { [EXTENSION_PATTERN]: {} },
    };
    const repaired = normalizeJsonSchema(requireObject(repairClosedExtension(tighter), "tighter"));
    expect(jsonEquals(repaired, normalizeJsonSchema(closed))).toBe(false);
    expect(classifySchemaChange(tighter, closed, "strict").length).toBeGreaterThan(0);
  });

  test("records only the proven surfaces and paths", async () => {
    const parsed = await Bun.file(resolve(REPO_ROOT, "sdk/compatibility-exceptions.json")).json();
    if (!Array.isArray(parsed)) throw new Error("exceptions must be an array");
    const recorded = new Set<string>();
    for (const entry of parsed) {
      if (!isJsonObject(entry) || entry.justification !== CLOSED_EXTENSION_JUSTIFICATION) continue;
      if (
        typeof entry.surface !== "string" ||
        typeof entry.changeKind !== "string" ||
        typeof entry.path !== "string"
      ) {
        throw new Error("closed-extension exception is incomplete");
      }
      recorded.add(exceptionKey(entry.surface, entry.changeKind, entry.path));
    }
    const expected = new Set(
      [...expectedClosedExtensionExceptions(), ...expectedWireExceptions()].map((entry) =>
        exceptionKey(entry.surface, entry.changeKind, entry.path),
      ),
    );
    expect([...recorded].sort()).toEqual([...expected].sort());
    expect(recorded.size).toBe(68);
  });
});
