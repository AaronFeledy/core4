import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installEngineComposition } from "@lando/engine/composition";
import type { SourceTransports } from "@lando/source-acquisition";
import "../../../src/runtime/bundled-plugins.ts";

const inputs = globalThis.__landoEngineCompositionInputs;
if (inputs === undefined) throw new Error("Bundled composition was not installed");
const sources: SourceTransports = {
  git: {
    fetch: async ({ dest }) => {
      await mkdir(dest, { recursive: true });
      await writeFile(
        join(dest, "fragment.yml"),
        "services:\n  web:\n    image: alpine\n    primary: true\n",
      );
      return { commit: "a".repeat(40) };
    },
  },
};
installEngineComposition({
  ...inputs,
  landofileSourcePorts: () => ({ sources }),
  landofileRuntimeInputs: {
    ...inputs.landofileRuntimeInputs,
    ports: {
      ...inputs.landofileRuntimeInputs.ports,
      sources,
    },
  },
});
