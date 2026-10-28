import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import { buildGithubActionsPins } from "../../../scripts/build-github-actions-pins.ts";

const repo = resolve(import.meta.dirname, "../../..");
const output = resolve(repo, "plugins/github-actions/src/pins.json");

test("projects reviewed receipts offline deterministically into the committed pin output", async () => {
  const first = Effect.runSync(buildGithubActionsPins());
  const second = Effect.runSync(buildGithubActionsPins());
  expect(first).toEqual(second);
  expect(await Bun.file(output).json()).toEqual(first);
  expect(first.artifacts).toHaveLength(6);
  expect(first.nodeRuntimes).toHaveLength(8);
  expect(first.images).toHaveLength(2);
  expect(first.artifacts.map((pin) => pin.id)).toEqual(first.artifacts.map((pin) => pin.id).sort());
  const scripts = (await Bun.file(resolve(repo, "package.json")).json()).scripts;
  expect(scripts["codegen:github-actions-pins"]).toBe("bun run scripts/build-github-actions-pins.ts");
});

test("importing the pin generator and private catalog performs no acquisition, writes or subprocesses", async () => {
  const source = `
    const forbidden = () => { throw new Error("unexpected side effect") };
    globalThis.fetch = forbidden;
    Bun.spawn = forbidden;
    Bun.spawnSync = forbidden;
    Bun.write = forbidden;
    await import(${JSON.stringify(resolve(repo, "scripts/build-github-actions-pins.ts"))});
    const pins = await import(${JSON.stringify(resolve(repo, "plugins/github-actions/src/pins.ts"))});
    const { Effect } = await import("effect");
    Effect.runSync(pins.selectNodeRuntime({runtime:"node20",os:"linux",arch:"x64",libc:"glibc",source:"nodejs"}));
    Effect.runSync(pins.selectImageCandidate({id:"actions-runner-2.338.1-linux-x64",os:"linux",arch:"x64"}));
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
});
