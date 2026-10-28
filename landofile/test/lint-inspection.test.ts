import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import type { LandofileRuntimeInputs } from "../src/ports.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-lint-inspection-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const remote = "includes:\n  - source: github:acme/shared\n    path: fragment.yml\n    version: main\n";
const fragment = "services:\n  web:\n    image: alpine\n";
const revision = "a".repeat(40);
const lockfile = (version: string, checksum = sha256Hex(fragment)) =>
  `# Retain this existing pin verbatim.\nincludes:\n  - source: github:acme/shared/fragment.yml\n    version: ${version}\n    resolved: ${revision}\n    checksum: ${checksum}\n`;
const fixture = (content = fragment) => {
  const refs: (string | undefined)[] = [];
  const inputs: LandofileRuntimeInputs = {
    templates: { modules: [] },
    stateStore: makeTestLandofileStateStore(),
    ports: {
      ...makeTestLandofilePorts(join(root, "cache")),
      git: {
        clone: async ({ dest, ref }) => {
          refs.push(ref);
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "fragment.yml"), content);
          return { commitSha: revision };
        },
      },
    },
  };
  return { inputs, refs };
};

for (const existing of [false, true]) {
  test.each([
    { label: "clean", content: fragment, overlay: "", valid: true, resolved: true },
    {
      label: "invalid effective",
      content: fragment,
      overlay: "runtime: wrong\n",
      valid: false,
      resolved: false,
    },
    {
      label: "invalid retained fragment",
      content: `${fragment}    primary: wrong\n`,
      overlay: "services:\n  web:\n    primary: true\n",
      valid: false,
      resolved: true,
    },
  ])(`$label lint leaves include pins untouched (existing=${existing})`, async (scenario) => {
    // Given: a remote requiring a new pin or replacement of an older selector.
    const { inputs, refs } = fixture(scenario.content);
    await writeFile(join(root, ".lando.yml"), `name: inspect\n${remote}${scenario.overlay}`);
    const lock = Bun.file(join(root, ".lando.lock.yml"));
    const before = lockfile("previous");
    if (existing) await writeFile(join(root, ".lando.lock.yml"), before);

    // When
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs));

    // Then: validation still runs through acquisition and effective finalization.
    expect(snapshot.result.valid).toBe(scenario.valid);
    expect(snapshot.resolved !== undefined).toBe(scenario.resolved);
    expect(refs).toEqual(["main"]);
    if (!scenario.valid) {
      expect(snapshot.result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            scopes: expect.arrayContaining([scenario.resolved ? "fragment" : "effective"]),
          }),
        ]),
      );
    }
    if (existing) expect(await lock.text()).toBe(before);
    else expect(await lock.exists()).toBe(false);
  });
}

test.each([true, false])(
  "checks the existing pin checksum without rewriting it (matches=%s)",
  async (matches) => {
    // Given: a matching selector whose pinned content must still be acquired and verified.
    const { inputs, refs } = fixture();
    await writeFile(join(root, ".lando.yml"), `name: inspect\n${remote}`);
    const before = lockfile("main", matches ? sha256Hex(fragment) : "0".repeat(64));
    const lock = Bun.file(join(root, ".lando.lock.yml"));
    await writeFile(join(root, ".lando.lock.yml"), before);

    // When
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs));

    // Then
    expect(refs).toEqual([revision]);
    expect(snapshot.result.valid).toBe(matches);
    expect(snapshot.result.violations.map(({ rule }) => rule)).toEqual(matches ? [] : ["landofile.load"]);
    expect(await lock.text()).toBe(before);
  },
);
