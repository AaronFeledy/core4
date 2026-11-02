import { describe, expect, test } from "bun:test";

import { lintYamlDocument, lintYamlFences } from "../../../scripts/lint-guides-yaml-fence.ts";
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
    ["proxy fragment", "proxy:\n  web:\n    - example.test", undefined, false],
    ["global proxy", "proxy:\n  defaultDomain: example.test", undefined, false],
    ["global events", "events:\n  deliveryQueueCapacity: 32", undefined, false],
    [
      "global overlapping keys",
      "proxy:\n  defaultDomain: example.test\nevents:\n  deliveryQueueCapacity: 32",
      undefined,
      false,
    ],
    ["invalid global proxy", "proxy:\n  defaultDomain: 32", undefined, true],
    ["invalid global events", "events:\n  deliveryQueueCapacity: invalid", undefined, true],
    [
      "mixed document shapes",
      "proxy:\n  defaultDomain: example.test\nevents:\n  pre-build:\n    - task: lint",
      undefined,
      true,
    ],
    ["overlap with unknown sibling", "proxy:\n  defaultDomain: example.test\nproxxy: {}", undefined, false],
    [
      "identifiable fragment with global value",
      "services: {}\nproxy:\n  defaultDomain: example.test",
      undefined,
      true,
    ],
    [
      "named document with global value",
      "name: example\nproxy:\n  defaultDomain: example.test",
      undefined,
      true,
    ],
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

  test.each(["full", "fragment"] as const)(
    "keeps explicit %s authoritative for shared keys",
    (formOverride) => {
      // Given a valid global value explicitly declared as a Landofile.
      const diagnostics: GuideLintDiagnostic[] = [];
      // When validating with the explicit form.
      lintYamlDocument({
        sourcePath: "probe.mdx",
        content: "proxy:\n  defaultDomain: example.test",
        cwd: import.meta.dir,
        fence: { type: "code", lang: "yaml" },
        formOverride,
        code: "guide.yaml-fence.invalid",
        parseCode: "guide.yaml-fence.parse",
        diagnostics,
      });
      // Then the global schema cannot rescue the invalid Landofile.
      expect(diagnostics.map(({ code }) => code)).toEqual(["guide.yaml-fence.invalid"]);
    },
  );
});
