import { describe, expect, test } from "bun:test";
import type { ExpressionNode } from "@lando/sdk/expressions";
import { phpSiteSnapshotBuilders } from "../../src/recipes/builtin/php-site-snapshot.ts";

// Captured from the unmodified Drupal and Drupal CMS expressions at efb9e76a5.
const routes = {
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
};
const mounts: ExpressionNode = {
  kind: "ArrayLiteral",
  elements: [
    {
      kind: "ObjectLiteral",
      entries: [
        { key: "source", value: { kind: "Literal", value: "./.lando/php/drupal-cms.ini" } },
        {
          key: "target",
          value: { kind: "Literal", value: "/usr/local/etc/php/conf.d/50-lando-drupal-cms.ini" },
        },
        { key: "readOnly", value: { kind: "Literal", value: true } },
      ],
    },
  ],
};
const databaseType = { key: "type", value: { kind: "Literal", value: "{{ recipe.database }}" } } as const;
const databaseName: ExpressionNode = { kind: "Literal", value: "{{ app.name }}" };
const apacheEntries = [
  { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
  { key: "primary", value: { kind: "Literal", value: true } },
  { key: "framework", value: { kind: "Literal", value: "drupal" } },
  { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
  { key: "composer", value: { kind: "Literal", value: "{{ recipe.composer }}" } },
  { key: "allowOverride", value: { kind: "Literal", value: true } },
  { key: "port", value: { kind: "Literal", value: 80 } },
  { key: "dependsOn", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] } },
];
const fpmEntries = [
  { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
  { key: "primary", value: { kind: "Literal", value: true } },
  { key: "framework", value: { kind: "Literal", value: "drupal" } },
  { key: "via", value: { kind: "Literal", value: "fpm" } },
  { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
  { key: "composer", value: { kind: "Literal", value: "{{ recipe.composer }}" } },
  { key: "dependsOn", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] } },
];
const common = {
  usesNginx: {
    kind: "Call",
    callee: "eq",
    args: [
      { kind: "Path", head: "options", segments: [{ type: "prop", name: "webserver" }] },
      { kind: "Literal", value: "nginx" },
    ],
  },
  primaryRoutes: routes,
  edgeService: {
    kind: "ObjectLiteral",
    entries: [
      { key: "type", value: { kind: "Literal", value: "nginx" } },
      { key: "backend", value: { kind: "Literal", value: "appserver" } },
      { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
      { key: "routes", value: routes },
    ],
  },
};
const cases = [
  {
    id: "drupal",
    options: { framework: "drupal" },
    expected: {
      ...common,
      databaseService: { kind: "ObjectLiteral", entries: [databaseType] },
      apacheAppserver: {
        kind: "ObjectLiteral",
        entries: [...apacheEntries, { key: "routes", value: routes }],
      },
      fpmAppserver: { kind: "ObjectLiteral", entries: fpmEntries },
    },
  },
  {
    id: "drupal-cms",
    options: {
      framework: "drupal",
      databaseFields: [["database", databaseName]],
      appserverMounts: () => structuredClone(mounts),
    },
    expected: {
      ...common,
      databaseService: {
        kind: "ObjectLiteral",
        entries: [databaseType, { key: "database", value: databaseName }],
      },
      apacheAppserver: {
        kind: "ObjectLiteral",
        entries: [...apacheEntries, { key: "mounts", value: mounts }, { key: "routes", value: routes }],
      },
      fpmAppserver: { kind: "ObjectLiteral", entries: [...fpmEntries, { key: "mounts", value: mounts }] },
    },
  },
] as const;

describe("PHP site snapshot builders", () => {
  for (const fixture of cases) {
    const builders = phpSiteSnapshotBuilders(fixture.options);
    for (const [name, build] of Object.entries(builders)) {
      test(`${fixture.id} ${name} preserves the baseline expression`, () => {
        const actual = build();
        expect(actual).toEqual(Reflect.get(fixture.expected, name));
      });
    }
    test(`${fixture.id} factories allocate disjoint trees across builders and successive calls`, () => {
      const seen = new Set<object>();
      const visit = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        expect(seen.has(value)).toBe(false);
        seen.add(value);
        for (const child of Object.values(value)) visit(child);
      };
      const nodes = Object.values(builders).flatMap((build) => [build(), build()]);
      for (const node of nodes) visit(node);
    });
  }

  test("database fields copy nested nodes instead of retaining caller references", () => {
    const nested: ExpressionNode = { kind: "ArrayLiteral", elements: [databaseName] };
    const builders = phpSiteSnapshotBuilders({ framework: "drupal", databaseFields: [["extra", nested]] });
    const actual = builders.databaseService();
    expect(actual).toEqual({
      kind: "ObjectLiteral",
      entries: [databaseType, { key: "extra", value: nested }],
    });
    expect(actual).not.toBe(builders.databaseService());
    switch (actual.kind) {
      case "ObjectLiteral": {
        const copied = actual.entries.find((entry) => entry.key === "extra")?.value;
        expect(copied).not.toBe(nested);
        if (copied?.kind === "ArrayLiteral") expect(copied.elements[0]).not.toBe(databaseName);
        break;
      }
      default:
        throw new TypeError("Expected database object expression");
    }
  });
});
