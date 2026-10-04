import { describe, expect, test } from "bun:test";
import { nodeWebSnapshotBuilders } from "../../src/recipes/builtin/node-web-snapshot.ts";

// Captured from the unmodified snapshot expressions at efb9e76a5.
const databaseEnabled = {
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
    { kind: "Literal", value: "none" },
  ],
};
const routes = {
  key: "routes",
  value: {
    kind: "ArrayLiteral",
    elements: [
      {
        kind: "ObjectLiteral",
        entries: [
          { key: "hostname", value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" } },
          { key: "scheme", value: { kind: "Literal", value: "both" } },
        ],
      },
    ],
  },
};
const dependency = {
  key: "dependsOn",
  value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
};
const cases = [
  {
    id: "astro",
    port: 4321,
    env: [["ASTRO_TELEMETRY_DISABLED", "1"]],
    entries: [
      { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
      { key: "port", value: { kind: "Literal", value: 4321 } },
      {
        key: "environment",
        value: {
          kind: "ObjectLiteral",
          entries: [{ key: "ASTRO_TELEMETRY_DISABLED", value: { kind: "Literal", value: "1" } }],
        },
      },
      routes,
    ],
  },
  {
    id: "nextjs",
    port: 3000,
    env: [["NEXTAUTH_PROVIDER", "{{ recipe.auth }}"]],
    entries: [
      { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
      { key: "port", value: { kind: "Literal", value: 3000 } },
      {
        key: "environment",
        value: {
          kind: "ObjectLiteral",
          entries: [{ key: "NEXTAUTH_PROVIDER", value: { kind: "Literal", value: "{{ recipe.auth }}" } }],
        },
      },
      routes,
    ],
  },
  {
    id: "sveltekit",
    port: 5173,
    env: [["SVELTEKIT_ADAPTER", "{{ recipe.adapter }}"]],
    entries: [
      { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
      { key: "port", value: { kind: "Literal", value: 5173 } },
      {
        key: "environment",
        value: {
          kind: "ObjectLiteral",
          entries: [{ key: "SVELTEKIT_ADAPTER", value: { kind: "Literal", value: "{{ recipe.adapter }}" } }],
        },
      },
      routes,
    ],
  },
] as const;

describe("Node web snapshot builders", () => {
  for (const fixture of cases) {
    const builders = nodeWebSnapshotBuilders(fixture);
    const withoutDatabase = { kind: "ObjectLiteral", entries: fixture.entries };
    const withDatabase = { kind: "ObjectLiteral", entries: [...fixture.entries, dependency] };
    const expected = {
      databaseEnabled,
      webServiceWithDatabase: withDatabase,
      webServiceWithoutDatabase: withoutDatabase,
      web: {
        kind: "Conditional",
        test: databaseEnabled,
        consequent: withDatabase,
        alternate: withoutDatabase,
      },
    };
    for (const [name, build] of Object.entries({
      databaseEnabled: builders.databaseEnabled,
      webServiceWithDatabase: () => builders.webService(true),
      webServiceWithoutDatabase: () => builders.webService(false),
      web: builders.web,
    })) {
      test(`${fixture.id} ${name} preserves the baseline expression`, () => {
        const actual = build();
        expect(actual).toEqual(Reflect.get(expected, name));
      });
      test(`${fixture.id} ${name} allocates disjoint trees on successive calls`, () => {
        const seen = new Set<object>();
        const visit = (value: unknown): void => {
          if (value === null || typeof value !== "object") return;
          expect(seen.has(value)).toBe(false);
          seen.add(value);
          for (const child of Object.values(value)) visit(child);
        };
        const pair = [build(), build()];
        for (const node of pair) visit(node);
      });
    }
  }
});
