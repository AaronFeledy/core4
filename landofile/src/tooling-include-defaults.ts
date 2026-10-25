import { type ValueOrigins, isPlainRecord } from "@lando/sdk/landofile";
import type { LandofileShape, ToolingVarLiteral } from "@lando/sdk/schema";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";

/** Include defaults stay separate from authored tasks until the strict runtime decode. */
export interface ToolingIncludeDefaults {
  readonly vars: Readonly<Record<string, ToolingVarLiteral>>;
  readonly varOrigins: ValueOrigins<AuthoredOrigin> | undefined;
}

export const layerIncludeDefaults = (
  outer: ToolingIncludeDefaults,
  inner: ToolingIncludeDefaults | undefined,
): ToolingIncludeDefaults => {
  if (inner === undefined) return outer;
  const origins = inner.varOrigins;
  const vars = { ...(origins?.replaced || origins?.deleted ? {} : outer.vars), ...inner.vars };
  const children = new Map(origins?.replaced || origins?.deleted ? [] : outer.varOrigins?.children);
  for (const [key, origin] of origins?.children ?? []) {
    children.set(key, origin);
    if (origin.deleted) delete vars[String(key)];
  }
  const root = origins ?? outer.varOrigins;
  return { vars, varOrigins: root === undefined ? undefined : { ...root, children } };
};

export const applyToolingIncludeDefaults = (
  document: LandofileShape,
  defaults: ReadonlyMap<string, ToolingIncludeDefaults>,
  composition: {
    readonly included: Readonly<Record<string, unknown>>;
    readonly authored: ValueOrigins<AuthoredOrigin>;
    readonly effective: ValueOrigins<AuthoredOrigin>;
  },
) => {
  const tooling = { ...document.tooling };
  const effectiveTasks = composition.effective.children.get("tooling");
  const taskOrigins = new Map(effectiveTasks?.children);
  const siteTasks = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
  const authoredTasks = composition.authored.children.get("tooling");
  for (const [name, included] of defaults) {
    const task = tooling[name];
    const authored = authoredTasks?.children.get(name);
    const origin = effectiveTasks?.children.get(name);
    if (
      task === undefined ||
      task.disabled ||
      origin === undefined ||
      authoredTasks?.replaced ||
      authored?.replaced ||
      authored?.deleted ||
      (authored !== undefined && (origin.replaced || !isPlainRecord(composition.included[name])))
    )
      continue;
    const ownVars = origin.children.get("vars");
    if (ownVars?.deleted || ownVars?.replaced) continue;
    const addedVars = Object.fromEntries(
      Object.entries(included.vars).filter(
        ([key]) => !Object.hasOwn(task.vars ?? {}, key) && !ownVars?.children.get(key)?.deleted,
      ),
    );
    if (Object.keys(addedVars).length === 0) continue;
    tooling[name] = { ...task, vars: { ...addedVars, ...task.vars } };
    const addedOrigins = new Map(
      [...(included.varOrigins?.children ?? [])].filter(([key]) => Object.hasOwn(addedVars, key)),
    );
    const varsOrigin = included.varOrigins ?? origin;
    const children = new Map(origin.children);
    children.set("vars", {
      ...varsOrigin,
      children: new Map([...addedOrigins, ...(ownVars?.children ?? [])]),
    });
    // Scalar command origins remain leaves until decodedPendingSites relocates them to .cmd.
    taskOrigins.set(name, { ...origin, children });
    siteTasks.set(name, {
      ...origin,
      children: new Map([["vars", { ...varsOrigin, children: addedOrigins }]]),
    });
  }
  const children = new Map(composition.effective.children);
  const root = effectiveTasks ?? composition.effective;
  children.set("tooling", { ...root, children: taskOrigins });
  return {
    document: document.tooling === undefined ? document : { ...document, tooling },
    origins: { ...composition.effective, children },
    addedOrigins: {
      ...composition.effective,
      children: new Map([["tooling", { ...root, children: siteTasks }]]),
    },
  };
};
