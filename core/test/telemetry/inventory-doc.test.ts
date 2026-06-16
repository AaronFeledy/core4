import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { TELEMETRY_EVENTS, type TelemetryEventScope } from "../../src/telemetry/inventory.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const docPath = resolve(repoRoot, "docs/telemetry/events.md");

interface ParsedField {
  readonly name: string;
  readonly type: string;
  readonly allowedValues?: ReadonlyArray<string>;
  readonly description: string;
}

interface ParsedEvent {
  readonly event: string;
  readonly owner: string;
  readonly trigger: string;
  readonly scope: TelemetryEventScope;
  readonly fields: ReadonlyArray<ParsedField>;
}

const SCOPE_LABELS: Readonly<Record<string, TelemetryEventScope>> = {
  "CLI-only": "cli-only",
  "Library-eligible": "library-eligible",
};

const backtickTokens = (cell: string): ReadonlyArray<string> =>
  [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);

const parseDoc = (markdown: string): ReadonlyArray<ParsedEvent> => {
  const lines = markdown.split("\n");
  const events: ParsedEvent[] = [];
  let current: {
    event: string;
    owner?: string;
    trigger?: string;
    scope?: TelemetryEventScope;
    fields: ParsedField[];
  } | null = null;

  const flush = (): void => {
    if (current === null) return;
    if (current.owner === undefined || current.trigger === undefined || current.scope === undefined) {
      throw new Error(`Event "${current.event}" is missing owner/trigger/scope metadata in events.md`);
    }
    events.push({
      event: current.event,
      owner: current.owner,
      trigger: current.trigger,
      scope: current.scope,
      fields: current.fields,
    });
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^### `([a-z-]+)`$/);
    if (heading !== null) {
      flush();
      current = { event: heading[1] as string, fields: [] };
      continue;
    }
    if (current === null) continue;

    const owner = line.match(/^- \*\*Owner:\*\* `(.+)`$/);
    if (owner !== null) {
      current.owner = owner[1] as string;
      continue;
    }
    const trigger = line.match(/^- \*\*Trigger:\*\* `(.+)`$/);
    if (trigger !== null) {
      current.trigger = trigger[1] as string;
      continue;
    }
    const scope = line.match(/^- \*\*Scope:\*\* (CLI-only|Library-eligible)$/);
    if (scope !== null) {
      current.scope = SCOPE_LABELS[scope[1] as string] as TelemetryEventScope;
      continue;
    }

    if (line.startsWith("| `")) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const [nameCell, typeCell, allowedCell, descriptionCell] = cells;
      const name = backtickTokens(nameCell ?? "")[0];
      if (name === undefined) continue;
      const allowed = (allowedCell ?? "").trim() === "(any)" ? undefined : backtickTokens(allowedCell ?? "");
      current.fields.push({
        name,
        type: (typeCell ?? "").trim(),
        allowedValues: allowed,
        description: (descriptionCell ?? "").trim(),
      });
    }
  }
  flush();
  return events;
};

describe("telemetry inventory doc consistency", () => {
  test("documents exactly the inventory events", async () => {
    const parsed = parseDoc(await readFile(docPath, "utf8"));
    expect(parsed.map((event) => event.event).sort()).toEqual(Object.keys(TELEMETRY_EVENTS).sort());
  });

  test("each documented event matches the inventory metadata and fields", async () => {
    const parsed = parseDoc(await readFile(docPath, "utf8"));
    const byName = new Map(parsed.map((event) => [event.event, event]));

    for (const [name, spec] of Object.entries(TELEMETRY_EVENTS)) {
      const doc = byName.get(name);
      expect(doc, `events.md must document "${name}"`).toBeDefined();
      if (doc === undefined) continue;
      expect(doc.owner).toBe(spec.owner);
      expect(doc.trigger).toBe(spec.trigger);
      expect(doc.scope).toBe(spec.scope);
      expect(doc.fields.map((field) => field.name)).toEqual(spec.fields.map((field) => field.name));
      for (const field of spec.fields) {
        const docField = doc.fields.find((candidate) => candidate.name === field.name);
        expect(docField, `events.md must document field "${name}.${field.name}"`).toBeDefined();
        if (docField === undefined) continue;
        expect(docField.type).toBe(field.type);
        expect(docField.allowedValues).toEqual(field.allowedValues);
        expect(docField.description).toBe(field.description);
      }
    }
  });

  test("states that no always-on runtime health events are recorded", async () => {
    const markdown = await readFile(docPath, "utf8");
    expect(markdown).toMatch(/always-on runtime health/i);
  });
});
