import { describe, expect, test } from "bun:test";

import { lintYamlFences } from "../../../scripts/lint-guides-yaml-fence.ts";
import type { GuideLintDiagnostic } from "../../../scripts/lint-guides.ts";

describe("YAML fence applicability", () => {
  test.each([
    ["unknown sibling", "services:\n  web:\n    imgae: nginx\nservcies: {}", undefined, true],
    ["flow mapping with unknown sibling", "services: {web: {imgae: nginx}}\nservcies: {}", undefined, true],
    ["Actions", "name: CI\non: push\njobs: {}", undefined, false],
    ["Kubernetes", "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: example}", undefined, false],
    ["recipe manifest", "id: example\ntitle: Example\nversion: 0.1.0", undefined, false],
    ["command envelope", "apiVersion: v4\ncommand: app:info\nok: true\nresult: {}", undefined, false],
    ["events fragment", "events:\n  pre-build:\n    - task: lint", undefined, false],
    ["unknown dialect-like sibling", "services:\n  web:\n    imgae: nginx\njobs: {}", undefined, true],
    ["title containing nolint", "services:\n  web:\n    imgae: nginx", 'title="nolint-example.yaml"', true],
    ["quoted nolint title", "services:\n  web:\n    imgae: nginx", 'title="example nolint file"', true],
    ["explicit nolint", "services:\n  web:\n    imgae: nginx", 'title="example file" nolint', false],
    ["bare service", "image: nginx\nhealthcheck: false", undefined, false],
    ["invalid bare service", "image: nginx\nimgae: nginx", undefined, true],
  ] as const)("classifies %s before restricted parsing", (_name, value, meta, invalid) => {
    // Given a real fenced YAML node, including metadata.
    const diagnostics: GuideLintDiagnostic[] = [];
    const root = { type: "code", lang: "yaml", value, ...(meta === undefined ? {} : { meta }) };

    // When the fence linter handles it.
    lintYamlFences("probe.mdx", root, diagnostics);

    // Then only identifiable authoring documents produce findings.
    expect(diagnostics.length > 0).toBe(invalid);
  });
});
