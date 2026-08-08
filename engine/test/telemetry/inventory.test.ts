import { describe, expect, test } from "bun:test";

import { TELEMETRY_EVENT_INVENTORY, UPDATE_OUTCOMES } from "../../src/telemetry/events.ts";
import {
  TELEMETRY_EVENTS,
  TELEMETRY_EVENT_FIELD_NAMES,
  type TelemetryEventSpec,
} from "../../src/telemetry/inventory.ts";

describe("telemetry event inventory source of truth", () => {
  test("declares exactly the two recorded events", () => {
    expect(Object.keys(TELEMETRY_EVENTS).sort()).toEqual(["deprecation-used", "update-outcome"]);
  });

  test("every event carries owner, trigger, scope, and field metadata", () => {
    for (const [name, spec] of Object.entries(TELEMETRY_EVENTS) as ReadonlyArray<
      readonly [string, TelemetryEventSpec]
    >) {
      expect(spec.event).toBe(name);
      expect(spec.owner.length).toBeGreaterThan(0);
      expect(spec.trigger.length).toBeGreaterThan(0);
      expect(["cli-only", "library-eligible"]).toContain(spec.scope);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.fields.length).toBeGreaterThan(0);
      for (const field of spec.fields) {
        expect(field.name.length).toBeGreaterThan(0);
        expect(field.type).toBe("string");
        expect(field.description.length).toBeGreaterThan(0);
        if (field.allowedValues !== undefined) {
          expect(field.allowedValues.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("constrains update-outcome fields and allowed values", () => {
    const spec = TELEMETRY_EVENTS["update-outcome"];
    expect(spec.fields.map((field) => field.name)).toEqual([
      "version",
      "targetVersion",
      "channel",
      "platform",
      "outcome",
    ]);
    const channel = spec.fields.find((field) => field.name === "channel");
    expect(channel?.allowedValues).toEqual(["stable", "next", "dev"]);
    const outcome = spec.fields.find((field) => field.name === "outcome");
    expect(outcome?.allowedValues).toEqual([...UPDATE_OUTCOMES]);
    expect(spec.scope).toBe("cli-only");
  });

  test("constrains deprecation-used fields and is library-eligible", () => {
    const spec = TELEMETRY_EVENTS["deprecation-used"];
    expect(spec.fields.map((field) => field.name)).toEqual(["kind", "id", "since", "severity"]);
    const severity = spec.fields.find((field) => field.name === "severity");
    expect(severity?.allowedValues).toEqual(["info", "warn", "error"]);
    expect(spec.scope).toBe("library-eligible");
  });

  test("field-name map matches the rich inventory field order", () => {
    for (const [name, spec] of Object.entries(TELEMETRY_EVENTS) as ReadonlyArray<
      readonly [keyof typeof TELEMETRY_EVENT_FIELD_NAMES, TelemetryEventSpec]
    >) {
      expect([...TELEMETRY_EVENT_FIELD_NAMES[name]]).toEqual(spec.fields.map((field) => field.name));
    }
  });

  test("events.ts re-exports the field-name map as the legacy inventory", () => {
    expect(TELEMETRY_EVENT_INVENTORY).toBe(TELEMETRY_EVENT_FIELD_NAMES);
  });
});
