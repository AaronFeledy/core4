import { expect, test } from "bun:test";
import { applyFinalizeOverrides } from "../src/pipeline/finalize-overrides.ts";
import { authoredDocumentFrom } from "../src/provenance.ts";

test("service selection removes excluded values and their origins without mutating authored input", () => {
  const document = {
    services: {
      disabled: { environment: { CHANGE: "authored" } },
      enabled: { type: "lando" },
    },
  };
  const authored = authoredDocumentFrom(document, {
    file: "/app/.lando.yml",
    layer: "canonical",
    path: [],
  });
  const origins = authored.provenance.origins;

  const selected = applyFinalizeOverrides(authored, { name: "global", excludedServices: ["disabled"] });

  expect(selected.value).toEqual({ name: "global", services: { enabled: { type: "lando" } } });
  expect(selected.value).not.toHaveProperty("excludedServices");
  expect(selected.provenance.origins.children.get("services")?.children.has("disabled")).toBe(false);
  expect(selected.provenance.origins.children.get("services")?.children.get("enabled")).toBe(
    origins.children.get("services")?.children.get("enabled"),
  );
  expect(document.services.disabled).toEqual({ environment: { CHANGE: "authored" } });
  expect(origins.children.get("services")?.children.has("disabled")).toBe(true);
});

test("absent services remain absent when only service exclusions are supplied", () => {
  const document = authoredDocumentFrom(
    { runtime: 4 },
    { file: "/app/.lando.yml", layer: "canonical", path: [] },
  );
  expect(applyFinalizeOverrides(document, { excludedServices: ["disabled"] }).value).toEqual({
    runtime: 4,
  });
});
