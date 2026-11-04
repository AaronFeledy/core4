import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandContribution } from "@lando/sdk/schema";

export const createCatalogFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-unified-catalog-"));
  const repo = resolve(import.meta.dirname, "../../../..");
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONFIG_ROOT: join(root, "config"),
    LANDO_USER_CONF_ROOT: join(root, "config"),
  };
  const registry: Record<string, { name: string; version: string; path: string }> = {};
  const install = async (name: string, commands: readonly CommandContribution[], owner = name) => {
    const path = join(root, ".lando/plugins", name.replaceAll("/", "-"));
    await mkdir(path, { recursive: true });
    const manifest = { name, version: "1.0.0", api: 4, entry: "index.ts", contributes: { commands } };
    await writeFile(join(path, "package.json"), JSON.stringify({ landoPlugin: manifest }));
    await writeFile(
      join(path, "index.ts"),
      `import { Effect, Schema } from "effect"; export const commands = new Map(${JSON.stringify(commands.filter((command) => command.id !== "fx:missing").map((command) => command.id))}.map(id => [id, async () => ({ id, namespace: id.split(":")[0], bootstrap: "plugins", resultSchema: Schema.String, run: () => Effect.succeed(${JSON.stringify(owner)}) })]));`,
    );
    registry[name] = { name, version: "1.0.0", path };
    await writeFile(join(root, ".lando/plugins/registry.json"), JSON.stringify(registry));
  };
  const landofile = (body = "") => writeFile(join(root, ".lando.yml"), `name: catalog-fixture\n${body}`);
  const invoke = async (args: readonly string[]) => {
    const child = Bun.spawn([process.execPath, join(repo, "core/bin/lando.ts"), ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);
    return { exit, stdout, stderr };
  };
  await landofile();
  return { root, env, install, landofile, invoke, cleanup: () => rm(root, { recursive: true, force: true }) };
};
