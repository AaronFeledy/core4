import { PortablePath } from "@lando/sdk/schema";
import { commonContainerLabels as labels } from "../../src/plan.ts";
import { bringUp as apply } from "../../src/podman/bring-up.ts";
import { emitCompose as emit } from "../../src/podman/compose.ts";
import { fixtureHelperMount, fixtureHelperOptions } from "./exec-supervision.ts";

export * from "../../src/podman/bring-up.ts";
export * from "../../src/podman/compose.ts";
export * from "../../src/plan.ts";

export const bringUp: typeof apply = (plan, options) => apply(plan, { ...fixtureHelperOptions, ...options });
export const emitCompose: typeof emit = (plan, options) =>
  emit(plan, { ...fixtureHelperOptions, ...options });
export const commonContainerLabels: typeof labels = (plan, service) =>
  labels(plan, {
    ...service,
    mounts: [
      ...service.mounts,
      { ...fixtureHelperMount, target: PortablePath.make(fixtureHelperMount.target) },
    ],
  });
