import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintFixtureLandofiles } from "../../../scripts/lint-guides-yaml-fixtures.ts";
import { type GuideLintDiagnostic, formatGuideLintDiagnostic } from "../../../scripts/lint-guides.ts";

describe("fixture Landofile invalid expectations", () => {
  test.each([
    {
      name: "unmarked invalid input is reported",
      content: "name: demo\nservices:\n  web:\n    notARealServiceKey: true\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-invalid: services.web.notARealServiceKey: Expected no excess property",
      ],
    },
    {
      name: "marked invalid input keeps its intended failure",
      content:
        "# lando-lint: expect-invalid demonstrate an unknown service key\nname: demo\nservices:\n  web:\n    notARealServiceKey: true\n",
      expected: [],
    },
    {
      name: "marked valid input reports a stale expectation",
      content:
        "# lando-lint: expect-invalid demonstrate an unknown service key\nname: demo\nservices:\n  web:\n    image: nginx\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-unexpected-valid: Fixture marked expect-invalid decoded successfully: demonstrate an unknown service key. Remove the marker or restore the intended invalid input.",
      ],
    },
    {
      name: "explicit lando3 expectation selects a different dialect",
      content: "# lando-lint: expect-invalid lando3 translation input\nname: demo\nrecipe: lamp\n",
      expected: [],
    },
    {
      name: "old nolint comments cannot hide invalid fixtures",
      content:
        "# nolint: demonstrate an unknown service key\nname: demo\nservices:\n  web:\n    notARealServiceKey: true\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-invalid: services.web.notARealServiceKey: Expected no excess property",
      ],
    },
    {
      name: "leading comments are supported by the real parser",
      content: "# A normal YAML comment.\nname: demo\nservices:\n  web:\n    image: nginx\n",
      expected: [],
    },
  ])("$name", async ({ content, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "fixture-lint-expectation-"));
    try {
      const sourcePath = "docs/guides/probe/fixtures/app";
      await mkdir(join(root, sourcePath), { recursive: true });
      await writeFile(join(root, sourcePath, ".lando.yml"), content);
      const diagnostics: GuideLintDiagnostic[] = [];

      await lintFixtureLandofiles(
        root,
        [{ name: "app", sourcePath, scope: "local", kind: "directory" }],
        diagnostics,
      );

      expect(diagnostics.map(formatGuideLintDiagnostic)).toEqual([...expected]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
