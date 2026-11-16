import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lintGuides } from "../../../scripts/lint-guides.ts";

const document = (body: string, id = "install-demo"): string =>
  `---\nid: ${id}\nprovider: test\n---\n\n${body}\n`;
const fence = (command: string, language = "sh"): string => `\`\`\`${language}\n${command}\n\`\`\``;
const scenario = (
  command: string,
  options: { readonly layer?: string; readonly variable?: string } = {},
): string =>
  [
    "<Guide>",
    `<Scenario id="install" layer="${options.layer ?? "e2e"}">`,
    '<Step name="install">',
    options.variable ?? "",
    command,
    "</Step>",
    '<Step name="cleanup"><Cleanup /></Step>',
    "</Scenario>",
    "</Guide>",
  ].join("\n");

interface InstallCase {
  readonly name: string;
  readonly prose: string;
  readonly exercise?: string;
  readonly keys: readonly string[];
  readonly otherGuide?: boolean;
  readonly variable?: string;
  readonly layer?: string;
  readonly language?: string;
}

const cases: readonly InstallCase[] = [
  {
    name: "accepts coverage in the same guide",
    prose: "lando drupal-scaffold",
    exercise: '<Run command="lando drupal-scaffold --yes" />',
    keys: [],
  },
  {
    name: "accepts coverage in another guide's recipe README",
    prose: 'lando create-project "vendor/project" "^2" --no-scripts',
    exercise: '<Run command="lando create-project vendor/project ^3" />',
    otherGuide: true,
    keys: [],
  },
  {
    name: "reports uncovered installs at the prose fence",
    prose: "lando create-project vendor/missing --no-scripts",
    keys: ["lando create-project vendor/missing"],
  },
  {
    name: "expands scenario values rather than display values in template literals",
    prose: "lando create-project vendor/project",
    exercise: "<Run command={`lando create-project {{ package }} --no-scripts`} />",
    variable: '<Variable name="package" value="vendor/project" display="vendor/display" />',
    keys: [],
  },
  {
    name: "joins line continuations and checks multiple commands in a fence",
    prose: "lando create-project \\\n  vendor/project \\\n  --no-scripts\nlando nextjs-scaffold",
    exercise: "<Run command={`lando create-project \\\n  vendor/project`} />",
    keys: ["lando nextjs-scaffold"],
  },
  {
    name: "matches composer packages through Verify",
    prose: "lando composer create-project 'vendor/project' tmp-app '^14' --prefer-dist",
    exercise:
      '<Verify command={`lando composer create-project vendor/project other-dir "^15"`} expect={{ exit: 0 }} />',
    keys: [],
  },
  {
    name: "reports composer packages independently",
    prose: "lando composer create-project vendor/missing tmp-app",
    exercise: '<Run command="lando composer create-project vendor/other tmp-app" />',
    keys: ["lando composer create-project vendor/missing"],
  },
  {
    name: "ignores non-install commands",
    prose: "lando start\nlando composer install\ncomposer create-project vendor/project\nlando info",
    keys: [],
  },
  {
    name: "refuses coverage from the test provider layer",
    prose: "lando drupal-scaffold",
    exercise: '<Run command="lando drupal-scaffold" />',
    layer: "scenario",
    keys: ["lando drupal-scaffold"],
  },
  ...["bash", "shell", "console"].map((language) => ({
    name: `checks ${language} prose fences`,
    prose: "lando drupal-scaffold",
    language,
    keys: ["lando drupal-scaffold"],
  })),
];

describe("guide.install.e2e-coverage", () => {
  test.each(cases)("$name", async ({ prose, exercise, keys, ...options }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-install-lint-"));
    try {
      const page = "docs/guides/install.mdx";
      const coverage = exercise === undefined ? "" : scenario(exercise, options);
      const files = {
        [page]: document(`${fence(prose, options.language)}\n\n${options.otherGuide ? "" : coverage}`),
        ...(options.otherGuide ? { "recipes/demo/README.mdx": document(coverage, "recipe-demo") } : {}),
      };
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }

      const { diagnostics } = await lintGuides(root);

      expect(diagnostics).toEqual(
        keys.map((key) => ({
          sourcePath: page,
          line: 6,
          column: 1,
          code: "guide.install.e2e-coverage",
          message: expect.stringContaining(`App install ${key} has no live e2e coverage.`),
        })),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
