import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LandofileShape } from "@lando/sdk/schema";
import { Schema } from "effect";
import { lastEnvelope, makeFixture, runSource } from "./subprocess-support.ts";

test.each(["1", "0", undefined])(
  "app config evaluates a conditional include with env=%s (#1569 QA21)",
  async (enabled) => {
    const fixture = await makeFixture("conditional-config");
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        "name: conditional\nincludes:\n  - source: ./cache.yml\n    when: \"{{ boolean(default(env.LANDO_TEST_WHEN, '0')) }}\"\n",
      );
      await writeFile(join(fixture.root, "cache.yml"), "services:\n  cache:\n    image: redis:7\n");
      const env = Object.fromEntries(
        Object.entries(fixture.env).filter(([key]) => key !== "LANDO_TEST_WHEN"),
      );
      const result = await runSource(
        { ...fixture, env: enabled === undefined ? env : { ...env, LANDO_TEST_WHEN: enabled } },
        ["app:config", "--format=json"],
      );
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ landofile: LandofileShape }) }),
      )(lastEnvelope(result.stdout));
      expect(Object.keys(envelope.result.landofile.services ?? {})).toEqual(enabled === "1" ? ["cache"] : []);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each(
  ["app:includes:update", "app:includes:verify"].flatMap((command) =>
    ["{{ env.LANDO_TEST_NEVER_SET }}", "{{ ("].map((when) => ({ command, when })),
  ),
)(
  "$command bypasses condition $when",
  async ({ command, when }) => {
    const fixture = await makeFixture("conditional-inventory");
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        `name: conditional\nincludes:\n  - source: ./fragment.yml\n    when: "${when}"\n`,
      );
      await writeFile(
        join(fixture.root, "fragment.yml"),
        "includes:\n  - source: ./nested.yml\n    when: false\n",
      );
      await writeFile(join(fixture.root, "nested.yml"), "services:\n  nested:\n    image: alpine:3\n");
      const result = await runSource(fixture, [command, "--format=json"]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(lastEnvelope(result.stdout)).toMatchObject({ ok: true });
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
