import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const validWorkflow =
  "name: Checks\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo PRIVATE_SCRIPT\n";
export const repository = async (files: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-actions-inspection-"));
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(join(root, ".github/workflows", name), content);
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
};
