import { join } from "node:path";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

export const SCRATCH_EXTENSION_KEY = "@lando/core/scratch";

/** Reject ids that `join` could use to escape `<userDataRoot>/scratch/<id>/`. */
export const isUnsafeScratchId = (id: string): boolean =>
  id.length === 0 || /[/\\\0]/u.test(id) || /^\.+$/u.test(id);

export type ScratchPaths = {
  readonly instanceRoot: AbsolutePath;
  readonly root: AbsolutePath;
  readonly planCache: AbsolutePath;
};

export const scratchPathsFor = (scratchDir: string, id: string): ScratchPaths => {
  const instanceRoot = AbsolutePath.make(join(scratchDir, id));
  return {
    instanceRoot,
    root: AbsolutePath.make(join(instanceRoot, "root")),
    planCache: AbsolutePath.make(join(instanceRoot, "plan.bin")),
  };
};

export const ScratchPlanExtension = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  projectRoot: Schema.optionalKey(AbsolutePath),
  shareGlobalStorage: Schema.optionalKey(Schema.Boolean),
});
export type ScratchPlanExtension = typeof ScratchPlanExtension.Type;

export const decodeScratchExtension = (plan: Pick<AppPlan, "extensions">): ScratchPlanExtension | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(ScratchPlanExtension)(plan.extensions[SCRATCH_EXTENSION_KEY]),
  );

/** New plans carry `projectRoot`. Historical `{ id }` plans do not. */
export const isManagedScratchPlan = (plan: Pick<AppPlan, "extensions">): boolean =>
  decodeScratchExtension(plan)?.projectRoot !== undefined;

export const scratchProjectRoot = (plan: Pick<AppPlan, "root" | "extensions">): string =>
  decodeScratchExtension(plan)?.projectRoot ?? String(plan.root);

export const stampScratchExtension = (
  plan: AppPlan,
  input: { readonly id: string; readonly projectRoot: AbsolutePath },
): AppPlan => {
  const existing = decodeScratchExtension(plan);
  return {
    ...plan,
    extensions: {
      ...plan.extensions,
      [SCRATCH_EXTENSION_KEY]: {
        ...(existing?.shareGlobalStorage === true ? { shareGlobalStorage: true } : {}),
        id: input.id,
        projectRoot: input.projectRoot,
      },
    },
  };
};
