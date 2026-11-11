import { bringUp as apply } from "../../src/podman/bring-up.ts";
import { emitCompose as emit } from "../../src/podman/compose.ts";
import { fixtureHelperOptions } from "./exec-supervision.ts";

export * from "../../src/plan.ts";
export * from "../../src/podman/bring-up.ts";
export * from "../../src/podman/compose.ts";
export { fixtureContainerLabels as commonContainerLabels } from "./exec-supervision.ts";

export const bringUp: typeof apply = (plan, options) => apply(plan, { ...fixtureHelperOptions, ...options });
export const emitCompose: typeof emit = (plan, options) =>
  emit(plan, { ...fixtureHelperOptions, ...options });
