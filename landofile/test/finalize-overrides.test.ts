import { expect, test } from "bun:test";
import { withValueOrigins } from "@lando/sdk/landofile";
import { applyFinalizeOverrides } from "../src/pipeline/finalize-overrides.ts";
import { getOrigins, rememberOrigins } from "../src/pipeline/origins.ts";

test("service selection removes excluded values and their origins without mutating authored input", () => {
  const document = {
    services: {
      disabled: { environment: { CHANGE: "authored" } },
      enabled: { type: "lando" },
    },
  };
  const origins = withValueOrigins(document, (path) => ({
    file: "/app/.lando.yml",
    layer: "canonical" as const,
    path,
  })).origins;
  rememberOrigins(document, origins);

  const selected = applyFinalizeOverrides(document, { name: "global", excludedServices: ["disabled"] });

  expect(selected).toEqual({ name: "global", services: { enabled: { type: "lando" } } });
  expect(selected).not.toHaveProperty("excludedServices");
  expect(getOrigins(selected)?.children.get("services")?.children.has("disabled")).toBe(false);
  expect(getOrigins(selected)?.children.get("services")?.children.get("enabled")).toBe(
    origins.children.get("services")?.children.get("enabled"),
  );
  expect(document.services.disabled).toEqual({ environment: { CHANGE: "authored" } });
  expect(origins.children.get("services")?.children.has("disabled")).toBe(true);
});

test("absent services remain absent when only service exclusions are supplied", () => {
  expect(applyFinalizeOverrides({ runtime: 4 }, { excludedServices: ["disabled"] })).toEqual({ runtime: 4 });
});
