/**
 * Doctor fixes that change the host after asking, such as installing the router's port helper.
 * Sections only inspect: a section whose fix would ask returns it instead of running it, and
 * doctor runs it after its section progress has finished. The question and sudo's prompt then get
 * a terminal no live task tree holds, and the progress tree stays whole. A fix keeps the services
 * its section saw, and brings doctor's own terminal questions and administrator access when the
 * section had neither.
 */
import * as HostPrivilegeService from "@lando/engine/services/privilege";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { InteractionService, PrivilegeService } from "@lando/sdk/services";
import { Effect, Layer, Option } from "effect";

import * as InteractionServiceLayer from "../../interaction/service.ts";
import { suspendCommandProgress } from "../command-progress";
import { hostHasPromptTerminal } from "../prompt-terminal";
import type { DoctorFinding, DoctorSectionResult } from "./doctor-contract";

export interface DoctorDeferredFix {
  /** The finding this fix settles: the section's findings with this name are replaced. */
  readonly check: string;
  /** Asks, changes the host, and inspects again; returns the findings that replace `check`'s. */
  readonly run: Effect.Effect<ReadonlyArray<DoctorFinding>>;
}

/** What a section returns: its findings, and the fixes to run once every section has reported. */
export type DoctorSectionRun = DoctorSectionResult & { readonly fixes?: ReadonlyArray<DoctorDeferredFix> };

const withHostServices = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const interaction = yield* Effect.serviceOption(InteractionService);
  const privilege = yield* Effect.serviceOption(PrivilegeService);
  const layers = [
    ...(Option.isSome(interaction) ? [] : [InteractionServiceLayer.layer]),
    ...(Option.isSome(privilege)
      ? []
      : [
          HostPrivilegeService.layer({
            handoff: { suspend: suspendCommandProgress },
            hasTerminal: hostHasPromptTerminal,
          }).pipe(Layer.provide(BunProcessRunner.layer)),
        ]),
  ];
  const [first, ...rest] = layers;
  return yield* first === undefined ? effect : effect.pipe(Effect.provide(Layer.mergeAll(first, ...rest)));
});

/** Defer `run` until doctor's section progress has finished, with the services this section sees. */
export const deferDoctorHostFix = Effect.fnUntraced(function* (
  check: string,
  run: Effect.Effect<ReadonlyArray<DoctorFinding>>,
) {
  const services = yield* Effect.context<never>();
  return {
    check,
    run: withHostServices(run).pipe(Effect.provide(services)),
  } satisfies DoctorDeferredFix;
});
