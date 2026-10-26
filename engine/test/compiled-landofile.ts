import { join } from "node:path";
import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { AbsolutePath, type LandofileShape, LoadScopedLandofile } from "@lando/sdk/schema";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import type { AppPlanner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

/** Only for already-decoded literal fixtures; authored expressions use compileTestLandofile. */
export const literalTestLandofile = (document: LandofileShape, root = process.cwd()) =>
  LoadScopedLandofile.make({
    stage: "load-scoped",
    document,
    pendingSites: [],
    context: { appRoot: AbsolutePath.make(root), env: {} },
  });

export const compileTestLandofile = (document: unknown, root = process.cwd()) => {
  const file = join(root, ".lando.yml");
  return loadAuthoredDocuments([{ file, value: document }], { appRoot: root, file });
};

export const planTestLandofile = (
  planner: Context.Service.Shape<typeof AppPlanner>,
  document: LandofileShape & { readonly stage?: never },
  capabilities: ProviderCapabilities,
) =>
  compileTestLandofile(document, getLandofileAppRoot(document) ?? process.cwd()).pipe(
    Effect.flatMap((compiled) => planner.plan(compiled, capabilities)),
  );

export const planLiteralTestLandofile = (
  planner: Context.Service.Shape<typeof AppPlanner>,
  document: LandofileShape & { readonly stage?: never },
  capabilities: ProviderCapabilities,
) =>
  planner.plan(literalTestLandofile(document, getLandofileAppRoot(document) ?? process.cwd()), capabilities);
