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
const fragmentFromInput = (input: ReturnType<typeof wireObject>) => {
  if (!Array.isArray(input.anyOf)) throw new Error("Missing captured input union");
  const documentSet = wireObject(
    input.anyOf.find(
      (branch) =>
        isJsonObject(branch) &&
        isJsonObject(branch.properties) &&
        "currentLowerV4Fragments" in branch.properties,
    ),
  );
  return schemaAt(documentSet, "$.currentLowerV4Fragments.items.fragment");
};
const captured = {
  input,
  fragment: fragmentFromInput(input),
  services: wireObject(payload.services),
};
const directiveCapture = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-wire.directives.json")).json(),
);
if (typeof directiveCapture.gzipBase64 !== "string") throw new Error("Missing directive capture bytes");
const directiveBytes = Bun.gunzipSync(Buffer.from(directiveCapture.gzipBase64, "base64"));
const directivePayload = wireObject(JSON.parse(new TextDecoder().decode(directiveBytes)));
const directiveInput = wireObject(directivePayload.input);
const directiveCaptured = {
  input: directiveInput,
  fragment: fragmentFromInput(directiveInput),
  services: wireObject(directivePayload.services),
};

describe("embedded wire closed x-* artifact repair", () => {
  test("pins the complete unmodified historical capture", () => {
    expect(capture.provenanceCommit).toBe("15133ee26729942dde7b9d4f0e033b4ced46406d");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "77b738b3e40b263ef65c47bd7d225e7297952b6d79a70a586949ef6fd119a514",
    );
  });

  test("pins the reviewed directive transport capture independently of the historical repair", () => {
    expect(directiveCapture.provenanceCommit).toBe("31996b06836f2647a61851f5a8d337df6d61ba23");
    expect(createHash("sha256").update(directiveBytes).digest("hex")).toBe(
      "28de00715c624a03f017e473db4124e9c137dae14064669f3957429c501be10a",
    );
    expect(jsonEquals(directiveCaptured.fragment, captured.fragment)).toBe(false);
  });

  for (const [id, path, source] of WIRE_TARGETS) {
    const surface = `schema:${id}`;
    test(`proves the complete directive-capable ${id} ${path} subtree`, async () => {
      // Given the reviewed directive transport, with every union alternative intact.
      const expected = directiveCaptured[source];
      const current = schemaAt(await loadNormalizedArtifact(surface), path);
      // When the complete current subtree is compared with its transport baseline.
      const repaired = normalizeJsonSchema(wireObject(repairClosedExtension(expected)));
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
      const repaired = normalizeJsonSchema(wireObject(repairClosedExtension(directiveCaptured[source])));
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
