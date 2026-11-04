import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseScriptFile } from "@lando/landofile/bun-sh-discovery";
import { Effect } from "effect";
import {
  bunShellScriptEnvironment,
  prepareBunShellScript,
} from "../../src/operations/tooling-bun-script-input.ts";
import { withBunScript } from "./tooling-bun-script-support.ts";

const cases = [
  { name: "constructor", suffix: "CONSTRUCTOR" },
  { name: "toString", suffix: "TOSTRING" },
  { name: "__proto__", suffix: "__PROTO__" },
].flatMap((input) => [false, true].map((supplied) => ({ ...input, supplied })));

test.each(cases)(
  "projects own values for $name when supplied=$supplied",
  async ({ name, suffix, supplied }) => {
    // Given
    const content = `# ---\n# flags:\n#   ${name}:\n# args:\n#   ${name}:\n# ---\necho ready\n`;
    await withBunScript(content, async (root) => {
      const script = await Effect.runPromise(
        parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
      );
      // When
      const prepared = await Effect.runPromise(
        prepareBunShellScript(script, {
          input: { _tag: "RawArgv", argv: supplied ? [`--${name}=flag-value`, "arg-value"] : [] },
        }),
      );
      const env = bunShellScriptEnvironment(prepared, {}, {});
      // Then
      expect(env[`LANDO_FLAG_${suffix}`]).toBe(supplied ? "flag-value" : "");
      expect(env[`LANDO_ARG_${suffix}`]).toBe(supplied ? "arg-value" : "");
      expect(prepared.input.flags).toEqual(supplied ? { [name]: "flag-value" } : {});
      expect(prepared.input.args).toEqual(supplied ? { [name]: "arg-value" } : {});
    });
  },
);
