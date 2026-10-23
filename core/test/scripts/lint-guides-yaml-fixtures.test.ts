import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintYamlDocument, lintYamlFences } from "../../../scripts/lint-guides-yaml-fence.ts";
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
      name: "lando3 text is only an invalid expectation reason",
      content: "# lando-lint: expect-invalid lando3 translation input\nname: demo\nrecipe: lamp\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-unexpected-valid: Fixture marked expect-invalid decoded successfully: lando3 translation input. Remove the marker or restore the intended invalid input.",
      ],
    },
    {
      name: "lando3 reason cannot hide a valid native document",
      content: "# lando-lint: expect-invalid lando3 translation input\nname: demo\nservices: {}\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-unexpected-valid: Fixture marked expect-invalid decoded successfully: lando3 translation input. Remove the marker or restore the intended invalid input.",
      ],
    },
    ...["# license\n", "\n", "\uFEFF# license\r\n"].map((prefix) => ({
      name: `marker after ${JSON.stringify(prefix)} is misplaced`,
      content: `${prefix}# lando-lint: expect-invalid unknown key\nname: demo\nnotAKey: true\n`,
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:2:1: guide.fixture.landofile-marker-placement: Put the expect-invalid marker on the first line of the fixture.",
      ],
    })),
    {
      name: "BOM and CRLF preserve first-line expectations",
      content: "\uFEFF# lando-lint: expect-invalid unknown key\r\nname: demo\r\nnotAKey: true\r\n",
      expected: [],
    },
    {
      name: "BOM and CRLF do not hide stale expectations",
      content: "\uFEFF# lando-lint: expect-invalid stale\r\nname: demo\r\nservices: {}\r\n",
      expected: [
        "docs/guides/probe/fixtures/app/.lando.yml:1:1: guide.fixture.landofile-unexpected-valid: Fixture marked expect-invalid decoded successfully: stale. Remove the marker or restore the intended invalid input.",
      ],
    },
    {
      name: "canonical document accepts native reset and override",
      content:
        "name: demo\nservices:\n  web:\n    image: nginx\n    healthcheck: !reset null\n    environment: !override\n      DEBUG: yes\n",
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

  test("full fixtures retain required fields when native directives are present", () => {
    const diagnostics: GuideLintDiagnostic[] = [];
    lintYamlDocument({
      sourcePath: ".lando.yml",
      content:
        "services:\n  web:\n    image: nginx\n    healthcheck: !reset null\ntoolingIncludes:\n  shared: {}\n",
      cwd: "/app",
      fence: { type: "code" },
      formOverride: "full",
      code: "invalid",
      parseCode: "parse",
      diagnostics,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toStartWith("toolingIncludes.shared.");
  });

  test.each([
    ["healthcheck: !reset null", false],
    ["environment: !override\n      DEBUG: yes", false],
    ["imgae: nginx\n    healthcheck: !reset null", true],
    ["ports:\n      - !reset null", true],
  ] as const)("checks full-fence native directive placement: %s", (body, invalid) => {
    const diagnostics: GuideLintDiagnostic[] = [];
    lintYamlFences(
      "probe.mdx",
      {
        type: "code",
        lang: "yaml",
        value: `name: demo\nservices:\n  web:\n    image: nginx\n    ${body}\n`,
      },
      diagnostics,
    );
    expect(diagnostics.length > 0).toBe(invalid);
  });
});
