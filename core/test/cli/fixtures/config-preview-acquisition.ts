import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installEngineComposition } from "@lando/engine/composition";
import "../../../src/runtime/bundled-plugins.ts";

const inputs = globalThis.__landoEngineCompositionInputs;
if (inputs === undefined) throw new Error("Bundled composition was not installed");
installEngineComposition({
  ...inputs,
  landofileRuntimeInputs: {
    ...inputs.landofileRuntimeInputs,
    ports: {
      ...inputs.landofileRuntimeInputs.ports,
      git: {
        clone: async ({ dest }) => {
          await mkdir(dest, { recursive: true });
          await writeFile(
            join(dest, "fragment.yml"),
            "services:\n  web:\n    image: alpine\n    primary: true\n",
          );
          return { commitSha: "a".repeat(40) };
        },
      },
    },
  },
});
