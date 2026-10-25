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
  withIntentionalChangesSinceCapture,
} from "./x-extension-closed-record.ts";
import { configOutputLandofile } from "./x-extension-config-output.ts";
import { evolveHistoricalContainerUser } from "./x-extension-container-user-proof.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { evolveHistoricalEnvironment } from "./x-extension-environment-proof.ts";
import { includeChecksumDelta } from "./x-extension-include-checksum-proof.ts";
import { CURRENT_SERVICE_PORT, evolveHistoricalServicePort } from "./x-extension-port-proof.ts";
import { evolveHistoricalShorthand, shorthandDelta } from "./x-extension-shorthand-proof.ts";
import { evolveHistoricalTimestamps, timestampsDelta } from "./x-extension-timestamps-proof.ts";
import { evolveHistoricalToolingShorthand } from "./x-extension-tooling-shorthand-proof.ts";
import { DIRECTIVE_TRANSPORT_JUSTIFICATION, expectedWireExceptions } from "./x-extension-wire-proof.ts";

const captured = parseCapturedExtension(await Bun.file(FIXTURE_PATH).json());
const capturedLandofile = withIntentionalChangesSinceCapture(captured.landofile);

const requireObject = (value: unknown, label: string): JsonSchema => {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
};

const repairedLandofile = (): JsonSchema =>
  normalizeJsonSchema(requireObject(repairClosedExtension(capturedLandofile), "repaired landofile"));

const expectedLandofile = (): JsonSchema =>
  evolveHistoricalToolingShorthand(
    evolveHistoricalEnvironment(
      evolveHistoricalEndpointMetadata(
        evolveHistoricalServicePort(
          evolveHistoricalTimestamps(
            evolveHistoricalContainerUser(evolveHistoricalShorthand(repairedLandofile())),
            "bare",
          ),
        ),
      ),
    ),
    "bare",
  );

describe("closed x-* extension artifact repair", () => {
  test("records the captured base artifact provenance", () => {
    expect(captured.provenanceCommit).toBe("15133ee26729942dde7b9d4f0e033b4ced46406d");
    expect(captured.pattern).toBe(EXTENSION_PATTERN);
  });

  test("pins historical repair independently of later shorthand evolution", () => {
    const repairedCapture = normalizeJsonSchema(
      requireObject(repairClosedExtension(captured.landofile), "repaired capture"),
    );
    expect(createHash("sha256").update(JSON.stringify(repairedCapture)).digest("hex")).toBe(
      "3e1bf2dce0e33bc8d22bc9664928c429355c5866dda24640dd9e6372be4e7ba2",
    );
    expect(shorthandDelta.provenanceCommit).toBe("4b13bf3bf278475b194cf0d82a3bc01de83325b2");
    expect(timestampsDelta.provenanceCommit).toBe("08d1490c6ae5773be71abfd3283faf8ebe4f9189");
    expect(includeChecksumDelta.provenanceCommit).toBe("e397cae8cb39233d4ec3a693dc533549f7cbb7f3");
  });

  test("repairs the captured landofile onto every current production embedding", async () => {
    // Given the normalized base landofile captured from commit 15133ee26, plus reviewed shorthand and port narrowing.
    const repaired = expectedLandofile();
    const surfaces = [
      ...CONFIG_COMMANDS.map((command) => `command:${command}`),
      "schema:TemplateRenderContext",
    ];
    // When each current embedding is normalized with the lawful normalizer.
    for (const surface of surfaces) {
      const current = configOutputLandofile(await loadNormalizedArtifact(surface));
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
    const landofile = configOutputLandofile(await loadNormalizedArtifact("command:app:config"));
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
    const current = configOutputLandofile(await loadNormalizedArtifact("command:app:config"));
    const findings = classifySchemaChange(
      { type: "object", properties: { landofile: capturedLandofile } },
      { type: "object", properties: { landofile: current } },
      "output",
    );
    expect(findings.map((finding) => `${finding.changeKind} ${finding.path}`).sort()).toEqual([
      "unsupported-construct $.landofile.events.post-destroy.items.anyOf",
      "unsupported-construct $.landofile.events.post-init.items.anyOf",
      "unsupported-construct $.landofile.events.post-rebuild.items.anyOf",
      "unsupported-construct $.landofile.events.post-restart.items.anyOf",
      "unsupported-construct $.landofile.events.post-start.items.anyOf",
      "unsupported-construct $.landofile.events.post-stop.items.anyOf",
      "unsupported-construct $.landofile.events.pre-destroy.items.anyOf",
      "unsupported-construct $.landofile.events.pre-init.items.anyOf",
      "unsupported-construct $.landofile.events.pre-rebuild.items.anyOf",
      "unsupported-construct $.landofile.events.pre-restart.items.anyOf",
      "unsupported-construct $.landofile.events.pre-start.items.anyOf",
      "unsupported-construct $.landofile.events.pre-stop.items.anyOf",
      "unsupported-construct $.landofile.toolingDefaults.env.anyOf",
      "unsupported-keyword $.landofile.additionalProperties",
      "unsupported-keyword $.landofile.events.additionalProperties",
      "unsupported-keyword $.landofile.patternProperties",
      "unsupported-keyword $.landofile.propertyNames",
      "unsupported-keyword $.landofile.services.additionalProperties",
      "unsupported-keyword $.landofile.tooling.additionalProperties",
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

  test("replays the port narrowing onto the service config only", () => {
    const repaired = repairedLandofile();
    const evolved = evolveHistoricalServicePort(repaired);
    const service = (graph: JsonSchema) =>
      requireObject(schemaAt(graph, "$.services.additionalProperties").properties, "service properties");
    expect(service(evolved).port).toEqual(CURRENT_SERVICE_PORT);
    expect(service(evolved).healthcheck).toEqual(service(repaired).healthcheck);
    expect(jsonEquals({ ...service(evolved), port: null }, { ...service(repaired), port: null })).toBe(true);
    expect(
      jsonEquals(
        { ...evolved, properties: { ...requireObject(evolved.properties, "p"), services: null } },
        { ...repaired, properties: { ...requireObject(repaired.properties, "p"), services: null } },
      ),
    ).toBe(true);
  });

  test("fails when an unrelated field in the repaired subtree changes", async () => {
    const repaired = expectedLandofile();
    const current = configOutputLandofile(await loadNormalizedArtifact("command:app:config"));
    expect(jsonEquals(repaired, current)).toBe(true);
    const properties = requireObject(current.properties, "properties");
    const mutated: JsonSchema = { ...current, properties: { ...properties, name: { type: "number" } } };
    expect(jsonEquals(repaired, mutated)).toBe(false);
  });

  test("rejects a constraint hidden inside the approved healthcheck union", async () => {
    const expected = expectedLandofile();
    const current = configOutputLandofile(await loadNormalizedArtifact("command:app:config"));
    const properties = requireObject(current.properties, "properties");
    const services = requireObject(properties.services, "services");
    const serviceProperties = requireObject(services.additionalProperties, "service");
    const fields = requireObject(serviceProperties.properties, "service properties");
    const healthcheck = requireObject(fields.healthcheck, "healthcheck");
    if (!Array.isArray(healthcheck.anyOf)) throw new Error("approved healthcheck union missing");
    const argv = healthcheck.anyOf.find(
      (branch) => isJsonObject(branch) && branch.type === "array" && isJsonObject(branch.items),
    );
    if (!isJsonObject(argv) || !isJsonObject(argv.items)) throw new Error("approved argv branch missing");
    const tightened = { ...argv, items: { ...argv.items, type: "number" } };
    const mutated: JsonSchema = {
      ...current,
      properties: {
        ...properties,
        services: {
          ...services,
          additionalProperties: {
            ...serviceProperties,
            properties: {
              ...fields,
              healthcheck: {
                ...healthcheck,
                anyOf: healthcheck.anyOf.map((branch) => (branch === argv ? tightened : branch)),
              },
            },
          },
        },
      },
    };
    expect(jsonEquals(expected, current)).toBe(true);
    expect(jsonEquals(expected, mutated)).toBe(false);
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
      if (
        !isJsonObject(entry) ||
        (entry.justification !== CLOSED_EXTENSION_JUSTIFICATION &&
          entry.justification !== DIRECTIVE_TRANSPORT_JUSTIFICATION)
      )
        continue;
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
