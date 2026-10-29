import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";
import { isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalAppMountAcceleration } from "./x-extension-app-mount-acceleration-proof.ts";
import { loadNormalizedArtifact, repairClosedExtension, schemaAt } from "./x-extension-closed-record.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { evolveHistoricalEnvironment } from "./x-extension-environment-proof.ts";
import { evolveHistoricalIncludeChecksum } from "./x-extension-include-checksum-proof.ts";
import { evolveHistoricalNetworks } from "./x-extension-networks-proof.ts";
import { evolveHistoricalShorthand } from "./x-extension-shorthand-proof.ts";
import { evolveHistoricalTimestamps } from "./x-extension-timestamps-proof.ts";
import {
  evolveHistoricalToolingSensitivity,
  evolveHistoricalToolingShorthand,
} from "./x-extension-tooling-shorthand-proof.ts";
import { typedCaptured } from "./x-extension-typed-checkpoint.ts";
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

// Graph normalization is synchronous and slow; cached inputs leave no IO yield before it.
const WIRE_TEST_TIMEOUT_MS = 120_000;
// Each evolved baseline depends only on its source subtree, and each surface artifact
// normalizes identically for every test, so compute both once per file.
const evolvedTypedCache = new Map<
  keyof typeof typedCaptured,
  ReturnType<typeof evolveHistoricalAppMountAcceleration>
>();
const evolvedTyped = (source: keyof typeof typedCaptured) => {
  const cached = evolvedTypedCache.get(source);
  if (cached !== undefined) return cached;
  const evolved = evolveHistoricalToolingSensitivity(
    evolveHistoricalAppMountAcceleration(
      evolveHistoricalToolingShorthand(
        evolveHistoricalEnvironment(
          evolveHistoricalEndpointMetadata(
            evolveHistoricalIncludeChecksum(
              evolveHistoricalTimestamps(
                evolveHistoricalShorthand(
                  evolveHistoricalNetworks(
                    normalizeJsonSchema(wireObject(repairClosedExtension(typedCaptured[source]))),
                    "authoring",
                  ),
                ),
                "authoring",
              ),
            ),
          ),
          "authoring",
        ),
        "authoring",
      ),
    ),
    "authoring",
  );
  evolvedTypedCache.set(source, evolved);
  return evolved;
};
const artifactCache = new Map<string, ReturnType<typeof loadNormalizedArtifact>>();
const currentArtifact = (surface: string) => {
  const cached = artifactCache.get(surface);
  if (cached !== undefined) return cached;
  const loaded = loadNormalizedArtifact(surface);
  artifactCache.set(surface, loaded);
  return loaded;
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

  test("pins repaired directive trees before applying subsequent grammar evolution", () => {
    const digests = {
      input: "b68b8625a33bcdcbeae07d9790e192345040b01f3e6491c6f492cb3a9f9d5903",
      services: "4a62c70951b94daa5a71e73b4f2589383a01e7eaca222742e02857c5ceb0e714",
      fragment: "5b719fe13342c9c39fda1d6b9405520ef5bde97c3b074b7d8578b66baa166a1b",
    };
    for (const source of ["input", "services", "fragment"] as const) {
      const repaired = normalizeJsonSchema(wireObject(repairClosedExtension(directiveCaptured[source])));
      expect(createHash("sha256").update(JSON.stringify(repaired)).digest("hex")).toBe(digests[source]);
    }
  }, 120_000);

  test("collapses an identifier-only local ref onto the same normalized graph", async () => {
    const repaired = evolveHistoricalAppMountAcceleration(
      evolveHistoricalEnvironment(
        evolveHistoricalEndpointMetadata(
          evolveHistoricalTimestamps(
            evolveHistoricalShorthand(
              evolveHistoricalNetworks(
                normalizeJsonSchema(wireObject(repairClosedExtension(typedCaptured.services))),
                "authoring",
              ),
            ),
            "authoring",
          ),
        ),
        "authoring",
      ),
    );
    const current = schemaAt(
      await loadNormalizedArtifact("schema:ConfigTranslateEncodeInput"),
      "$.context.services",
    );
    const aliased = normalizeJsonSchema({ $defs: { Services: current }, $ref: "#/$defs/Services" });
    const drifted = normalizeJsonSchema({
      $defs: { Services: { type: "number" } },
      $ref: "#/$defs/Services",
    });
    expect(jsonEquals(repaired, current)).toBe(true);
    expect(jsonEquals(repaired, aliased)).toBe(true);
    expect(Object.hasOwn(aliased, "$ref")).toBe(false);
    expect(jsonEquals(repaired, drifted)).toBe(false);
  });

  for (const [id, path, source] of WIRE_TARGETS) {
    const surface = `schema:${id}`;
    test(
      `proves the complete directive-capable ${id} ${path} subtree`,
      async () => {
        // Given the independently pinned typed grammar, with every union alternative intact.
        const current = schemaAt(await currentArtifact(surface), path);
        // When the separately reviewed shorthand, timestamps, and include-checksum deltas follow closed-x repair.
        const repaired = evolvedTyped(source);
        // Then the entire normalized subtree matches, not just the reported keyword.
        expect(jsonEquals(repaired, current)).toBe(true);
        expect(classifySchemaChange(repaired, current, "strict")).toEqual([]);
      },
      WIRE_TEST_TIMEOUT_MS,
    );

    test(
      `requires exact acceptance for raw ${id} ${path}`,
      async () => {
        // Given the unrepaired capture at the actual reported surface path.
        const current = schemaAt(await currentArtifact(surface), path);
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
      },
      WIRE_TEST_TIMEOUT_MS,
    );

    test(
      `rejects an unrelated value constraint hidden by ${id} ${path}.anyOf`,
      async () => {
        // Given a current subtree whose first string constraint is independently tightened.
        const current = schemaAt(await currentArtifact(surface), path);
        const mutated = normalizeJsonSchema(wireObject(tightenWireString(current)));
        const repaired = evolvedTyped(source);
        expect(jsonEquals(repaired, current)).toBe(true);
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
      },
      WIRE_TEST_TIMEOUT_MS,
    );
  }
});
