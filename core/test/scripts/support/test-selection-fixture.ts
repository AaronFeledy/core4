import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestInventoryOptions } from "../../../../scripts/test-ownership.ts";
import type { TestSelection } from "../../../../scripts/test-selections.ts";

export const createTestSelectionFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-test-selection-"));
  const put = async (path: string, content = "export {};\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const child = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  await put("package.json", JSON.stringify({ workspaces: ["pkg"] }));
  await put("pkg/package.json", JSON.stringify({ name: "@fixture/pkg" }));
  await put("pkg/test/unit.test.ts");
  await put("pkg/test/live.integration.test.ts");
  const selections: readonly TestSelection[] = [
    {
      id: "live",
      paths: ["pkg/test/live.integration.test.ts"],
      jobs: [{ workflow: "ci.yml", job: "live" }],
      needs: "Fixture socket",
    },
  ];
  const workflow = async (
    run = "bun run test:selection live",
    shards: readonly number[] = [1, 2, 3],
    options: { readonly if?: boolean | string; readonly unitRun?: string } = {},
  ) =>
    put(
      ".github/workflows/ci.yml",
      Bun.YAML.stringify({
        jobs: {
          live: { steps: [{ run, ...(options.if === undefined ? {} : { if: options.if }) }] },
          "unit-tests-linux-x64-shard": {
            strategy: { matrix: { shard: shards } },
            steps: [{ run: options.unitRun ?? "bun run test:unit:shard ${{ matrix.shard }}/3" }],
          },
        },
      }),
    );
  await workflow();
  const options: TestInventoryOptions = {
    root,
    selections,
    planChecks: [],
    manual: {},
    workflowRoot: join(root, ".github/workflows"),
  };
  return {
    root,
    put,
    workflow,
    selections,
    options,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
};
