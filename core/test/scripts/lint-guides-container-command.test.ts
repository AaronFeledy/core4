import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lintGuides } from "../../../scripts/lint-guides.ts";

const page = "docs/guides/example.mdx";
const other = "recipes/other/README.mdx";
const removed = "docs/guides/removed.mdx";
const baselinePath = "scripts/guides/container-command-baseline.json";
const command = "lando exec app -- php -m";
const run = `<Run command="${command}" />`;
const waiver = "{/* lando-lint: not-e2e Needs a TTY in CI */}";
const code = "guide.container-command.e2e-coverage";
const doc = (body: string, extra = "", id = "example") =>
  `---\nid: ${id}\nprovider: test\n${extra}---\n\n${body}\n`;
const fence = (source: string, lang = "sh") => `\`\`\`${lang}\n${source}\n\`\`\``;
const step = (content: string) => `<Step name="exercise">${content}</Step>`;
const scenario = (body: string, attrs = 'layer="e2e"') =>
  `<Guide>\n<Scenario id="exercise" ${attrs}>\n${body}\n<Step name="cleanup"><Cleanup /></Step>\n</Scenario>\n</Guide>`;

const withRepo = async <A>(files: Readonly<Record<string, string>>, use: (root: string) => Promise<A>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-container-command-lint-"));
  try {
    for (const [path, value] of Object.entries(files)) {
      const dest = join(root, path);
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, value);
    }
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  { name: "requires an exact argv on the same page", prose: command, body: step(run), expected: [] },
  { name: "rejects missing coverage", prose: command, expected: [command] },
  {
    name: "rejects near matches",
    prose: command,
    body: step('<Run command="lando exec app -- php -v" />'),
    expected: [command],
  },
  {
    name: "rejects coverage on another page",
    prose: command,
    elsewhere: true,
    body: step(run),
    expected: [command],
  },
  {
    name: "inherits the guide layer",
    prose: command,
    attrs: "",
    extra: "defaultLayer: e2e\n",
    body: step(run),
    expected: [],
  },
  {
    name: "rejects a scenario layer override",
    prose: command,
    attrs: 'layer="scenario"',
    extra: "defaultLayer: e2e\n",
    body: step(run),
    expected: [command],
  },
  {
    name: "rejects skipped steps alongside running steps",
    prose: command,
    body: `<Skip reason="Not run here">${step(run)}</Skip>\n<Step name="check"><Run command="lando info" /></Step>`,
    expected: [command],
  },
  {
    name: "rejects a variant-skipped scenario",
    prose: command,
    body: step(run),
    extra: "tabs: [demo]\nvariants:\n  demo:\n    skip:\n      reason: Not run here\n",
    expected: [command],
  },
  {
    name: "accepts a hidden Verify with Variable.value",
    prose: command,
    body: `<Hidden reason="Exercise exact argv">${step('<Variable name="service" value="app" display="other" /><Verify command="lando exec {{service}} -- php -m" />')}</Hidden>`,
    expected: [],
  },
  { name: "strips a console prompt", prose: `$ ${command}`, lang: "console", expected: [command] },
  {
    name: "joins continuations and scans zsh lists",
    prose: "lando exec app -- php \\\n  -m && lando app:logs app",
    lang: "zsh",
    expected: [command, "lando app:logs app"],
  },
  {
    name: "checks the left side of shell glue",
    prose: `${command} 2> errors | grep PHP; lando psql < seed.sql`,
    expected: [command, "lando psql"],
  },
  {
    name: "ignores templates rather than treating them as redirects",
    prose:
      "lando exec <service> -- php -m; lando logs --service='<name>'\nlando psql ...\nlando exec app -- printf 'left<=>right'",
    expected: ["lando exec app -- printf 'left<=>right'"],
  },
  {
    name: "checks tooling but ignores built-in host commands",
    prose: "lando start\nlando app:stop\nlando help\nlando composer --version",
    expected: ["lando composer --version"],
  },
] as const)("$name", async (fixture) => {
  const coverage =
    "body" in fixture ? scenario(fixture.body, "attrs" in fixture ? fixture.attrs : undefined) : "";
  const files = "elsewhere" in fixture ? { [other]: doc(coverage, "", "other") } : {};
  const diagnostics = await withRepo(
    {
      ...files,
      [page]: doc(
        `${fence(fixture.prose, "lang" in fixture ? fixture.lang : undefined)}\n\n${"elsewhere" in fixture ? "" : coverage}`,
        "extra" in fixture ? fixture.extra : "",
      ),
    },
    async (root) => (await lintGuides(root)).diagnostics,
  );
  expect(diagnostics).toEqual(
    fixture.expected.map((argv) => ({
      sourcePath: page,
      line: 6 + ("extra" in fixture ? fixture.extra.split("\n").length - 1 : 0),
      column: 1,
      code,
      message: expect.stringContaining(`\`${argv}\``),
    })),
  );
});

test.each([
  ["waives all commands in the next fence", `${waiver}\n\n${fence(`${command}\nlando ssh`)}`, []],
  [
    "rejects a short reason",
    `{/* lando-lint: not-e2e TTY */}\n${fence(command)}`,
    [
      [6, "at least 8 characters"],
      [7, command],
    ],
  ],
  [
    "rejects a malformed directive",
    `{/* lando-lint not-e2e Needs a TTY */}\n${fence(command)}`,
    [
      [6, "at least 8 characters"],
      [7, command],
    ],
  ],
  [
    "rejects a waiver separated by another comment",
    `${waiver}\n{/* note */}\n${fence(command)}`,
    [
      [6, "directly above the shell fence"],
      [8, command],
    ],
  ],
  ["rejects a dangling waiver", waiver, [[6, "directly above the shell fence"]]],
  [
    "rejects a waiver without a container command",
    `${waiver}\n${fence("lando start")}`,
    [[6, "Remove this stale not-e2e waiver"]],
  ],
] as const)("%s", async (_name, body, expected) => {
  const diagnostics = await withRepo(
    { [page]: doc(body) },
    async (root) => (await lintGuides(root)).diagnostics,
  );
  expect(diagnostics).toEqual(
    expected.map(([line, fragment]) =>
      expect.objectContaining({ code, line, message: expect.stringContaining(fragment) }),
    ),
  );
});

test("the baseline is page-specific and flags covered, waived, and removed commands for deletion", async () => {
  const covered = "lando logs";
  const waived = "lando ssh";
  const absent = "lando psql";
  const diagnostics = await withRepo(
    {
      [page]: doc(
        `${fence(`${command}\n${covered}`)}\n\n${waiver}\n${fence(waived)}\n\n${scenario(step(`<Run command="${covered}" />`))}`,
      ),
      [other]: doc(fence(command), "", "other"),
      [baselinePath]: JSON.stringify({ [page]: [command, covered, waived, absent], [removed]: [command] }),
    },
    async (root) => (await lintGuides(root)).diagnostics,
  );
  expect(diagnostics).toEqual([
    expect.objectContaining({ sourcePath: other, code, message: expect.stringContaining(`\`${command}\``) }),
    ...[covered, waived, absent].map((argv) =>
      expect.objectContaining({
        sourcePath: page,
        code,
        message: expect.stringContaining(JSON.stringify(argv)),
      }),
    ),
    expect.objectContaining({
      sourcePath: removed,
      code,
      message: expect.stringContaining(JSON.stringify(command)),
    }),
  ]);
});

test("prune removes only stale entries and still reports a newly uncovered command", async () => {
  const added = "lando app:ssh -s app";
  const outcome = await withRepo(
    {
      [page]: doc(fence(`${command}\n${added}`)),
      [baselinePath]: JSON.stringify({ [page]: [command, "lando logs"], [removed]: ["lando drush"] }),
    },
    async (root) => {
      const { diagnostics } = await lintGuides(root, { pruneContainerCommandBaseline: true });
      return { diagnostics, baseline: await Bun.file(join(root, baselinePath)).json() };
    },
  );
  expect(outcome.baseline).toEqual({ [page]: [command] });
  expect(outcome.diagnostics).toEqual([
    expect.objectContaining({ code, message: expect.stringContaining(`\`${added}\``) }),
  ]);
});
