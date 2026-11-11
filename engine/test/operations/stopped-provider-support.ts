import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

export const stoppedProviderFixtures = ["generic idle", "stopped Windows"] as const;
export type StoppedProviderFixture = (typeof stoppedProviderFixtures)[number];

export const stoppedProviderInspection =
  (
    fixture: StoppedProviderFixture,
    running: () => boolean,
    online: ReturnType<NonNullable<RuntimeProviderShape["inspectAppliedFileSync"]>> = Effect.succeed({
      status: "ordinary",
    }),
  ): NonNullable<RuntimeProviderShape["inspectAppliedFileSync"]> =>
  () =>
    fixture === "stopped Windows" && !running() ? Effect.succeed({ status: "unknown" }) : online;
