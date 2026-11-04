import { join } from "node:path";
import { plugin } from "@lando/lando4";
import type { RecipeInitPreparationRequest } from "../../../src/recipes/prepared-init.ts";
import { ownerOnlyFileAccess } from "../../_support/private-file-access.ts";
import { compileTestSource, testSource } from "./prepared-source.ts";

export const pipelineSourceFixture = async (root: string, patch: Record<string, unknown>) => {
  await Bun.write(join(root, "asset"), "isolated = true\n");
  const source = {
    ...testSource,
    config: { runtime: 4, services: { app: { type: "php:{{ recipe.php }}", webroot: "web" } } },
    files: [{ src: "asset", dest: "config/isolated.conf" }],
    postInit: [{ type: "message", text: "ready" }],
    ...patch,
    options: {
      php: { type: { kind: "string" }, default: "8.3" },
      ...(typeof patch.options === "object" && patch.options !== null ? patch.options : {}),
    },
  };
  const compiled = await compileTestSource(source, root);
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  const request: RecipeInitPreparationRequest = {
    compiled,
    appRoot: join(root, "app"),
    appName: "chosen-name",
    answers: {},
    encoder: await loader(),
  };
  const publication = { journalRoot: () => join(root, "journal"), privateFileAccess: ownerOnlyFileAccess };
  return { root, request, publication };
};
