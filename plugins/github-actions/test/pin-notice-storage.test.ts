import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import manifest from "../src/pins.json";

const repo = resolve(import.meta.dirname, "../../..");
const noticesDirectory = "plugins/github-actions/src/pins-notices";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("preserves complete upstream notice bytes in Git storage and checkout under text normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-pin-notice-storage-"));
  const emptyConfig = join(root, "empty.gitconfig");
  await Bun.write(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: readonly string[]) => {
    const child = Bun.spawn({
      cmd: ["git", "-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args],
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
      return stdout;
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  };
  try {
    await git(["init", "--quiet"]);
    await Bun.write(join(root, ".gitattributes"), await Bun.file(join(repo, ".gitattributes")).bytes());
    const localAttributes = join(noticesDirectory, ".gitattributes");
    await mkdir(dirname(join(root, localAttributes)), { recursive: true });
    const attributes = Bun.file(join(repo, localAttributes));
    if (await attributes.exists()) await Bun.write(join(root, localAttributes), await attributes.bytes());
    for (const notice of manifest.notices) {
      const path = `plugins/github-actions/src/${notice.path}`;
      await Bun.write(join(root, path), await Bun.file(join(repo, path)).bytes());
    }
    await git(["add", "--", ".gitattributes", noticesDirectory]);
    for (const notice of manifest.notices) {
      const path = `plugins/github-actions/src/${notice.path}`;
      expect(hash(await git(["show", `:${path}`]))).toBe(notice.sha256);
    }
    expect((await git(["diff", "--cached", "--check"])).length).toBe(0);
    await git(["checkout-index", "--all", "--force"]);
    for (const notice of manifest.notices) {
      const path = `plugins/github-actions/src/${notice.path}`;
      expect(hash(await Bun.file(join(root, path)).bytes())).toBe(notice.sha256);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
