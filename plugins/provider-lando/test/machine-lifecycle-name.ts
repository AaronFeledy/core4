import { randomUUID } from "node:crypto";

export type LifecycleMachineKind = "managed" | "system";

export const makeLifecycleMachineName = (kind: LifecycleMachineKind): string =>
  `lando-lifecycle-${kind}-${randomUUID()}`;
