/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bootstrap-layers.ts`.
 *
 * Source of truth: `scripts/build-bootstrap-layers.ts`, `BootstrapLevel`, and the
 * core runtime service membership graph.
 *
 * Bootstrap layer composition is emitted ahead of time so hand-authored
 * runtime factories do not rebuild the Effect Layer graph outside this
 * generated output.
 */

import { Context, Layer } from "effect";

import { EventService } from "@lando/sdk/services";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeCommandsBootstrapBaseLayer } from "./commands.ts";

export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const toolingBase = makeCommandsBootstrapBaseLayer(inputs);
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(toolingBase));
  return Layer.merge(toolingBase, subscriberRuntimeLive).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("tooling", Context.get(context, EventService))),
  );
};
