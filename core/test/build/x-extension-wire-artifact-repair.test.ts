import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";
import { isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { loadNormalizedArtifact, repairClosedExtension, schemaAt } from "./x-extension-closed-record.ts";
import {
  WIRE_TARGETS,
  atWirePath,
  expectedWireExceptions,
  tightenWireString,
  wireObject,
} from "./x-extension-wire-proof.ts";

const capture = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-wire.base.json")).json(),
);
if (typeof capture.gzipBase64 !== "string") throw new Error("Missing captured wire bytes");
const bytes = Bun.gunzipSync(Buffer.from(capture.gzipBase64, "base64"));
const payload = wireObject(JSON.parse(new TextDecoder().decode(bytes)));
const input = wireObject(payload.input);
if (!Array.isArray(input.anyOf)) throw new Error("Missing captured input union");
const documentSet = wireObject(
  input.anyOf.find(
    (branch) =>
      isJsonObject(branch) &&
      isJsonObject(branch.properties) &&
      "currentLowerV4Fragments" in branch.properties,
  ),
);
const captured = {
  input,
  fragment: schemaAt(documentSet, "$.currentLowerV4Fragments.items.fragment"),
  services: wireObject(payload.services),
};

describe("embedded wire closed x-* artifact repair", () => {
  test("pins the complete unmodified historical capture", () => {
    expect(capture.provenanceCommit).toBe("15133ee26729942dde7b9d4f0e033b4ced46406d");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "77b738b3e40b263ef65c47bd7d225e7297952b6d79a70a586949ef6fd119a514",
    );
  });

  for (const [id, path, source] of WIRE_TARGETS) {
    const surface = `schema:${id}`;
    test(`proves the complete repaired ${id} ${path} subtree`, async () => {
      // Given the captured historical subtree, with every union alternative intact.
      const before = captured[source];
      const current = schemaAt(await loadNormalizedArtifact(surface), path);
      // When only the exact closed-extension producer signature is repaired.
      const repaired = normalizeJsonSchema(wireObject(repairClosedExtension(before)));
      // Then the entire normalized subtree matches, not just the reported keyword.
      expect(jsonEquals(repaired, current)).toBe(true);
      expect(classifySchemaChange(repaired, current, "strict")).toEqual([]);
    });

    test(`requires exact acceptance for raw ${id} ${path}`, async () => {
      // Given the unrepaired capture at the actual reported surface path.
      const current = schemaAt(await loadNormalizedArtifact(surface), path);
      const before = atWirePath(captured[source], path);
      // When classified without altering the baseline or suppressing unions.
      const findings = classifySchemaChange(before, atWirePath(current, path), "strict");
      // Then raw findings stay unknown and only the exact surface/path can accept them.
      expect(findings).toMatchObject([
        {
          verdict: "unknown",
          changeKind: "unsupported-construct",
          path: `${path}.anyOf`,
          accepted: false,
        },
      ]);
      expect(findings).toHaveLength(1);
      const exact = expectedWireExceptions().filter(
        (entry) => entry.surface === surface && entry.path === `${path}.anyOf`,
      );
      expect(acceptCompatibilityExceptions(surface, findings, exact)[0]?.accepted).toBe(true);
      expect(acceptCompatibilityExceptions(`${surface}:wrong`, findings, exact)[0]?.accepted).toBe(false);
      expect(
        acceptCompatibilityExceptions(
          surface,
          findings,
          exact.map((entry) => ({ ...entry, path: `${entry.path}.wrong` })),
        )[0]?.accepted,
      ).toBe(false);
    });

    test(`rejects an unrelated value constraint hidden by ${id} ${path}.anyOf`, async () => {
      // Given a current subtree whose first string constraint is independently tightened.
      const current = schemaAt(await loadNormalizedArtifact(surface), path);
      const mutated = normalizeJsonSchema(wireObject(tightenWireString(current)));
      const repaired = normalizeJsonSchema(wireObject(repairClosedExtension(captured[source])));
      // When the conservative classifier still reports the same coarse union delta.
      const findings = classifySchemaChange(
        atWirePath(captured[source], path),
        atWirePath(mutated, path),
        "strict",
      );
      expect(findings.map((entry) => entry.path)).toEqual([`${path}.anyOf`]);
      // Then whole-subtree equality detects the change despite the coarse exception.
      expect(jsonEquals(repaired, mutated)).toBe(false);
      expect(jsonEquals(current, mutated)).toBe(false);
    });
  }
});
