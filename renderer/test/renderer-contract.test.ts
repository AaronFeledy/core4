import { test } from "bun:test";
import * as EventService from "@lando/engine/services/event-service";
import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_VERBOSE_TTY } from "@lando/sdk/renderer";
import { makeRendererContractSuite } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  layerJson,
  layerJsonService,
  layerPlain,
  layerPlainService,
  layerVerbose,
  layerVerboseService,
} from "../src/runtime.ts";

for (const contribution of [
  { id: "plain", makeService: layerPlainService, makeEventConsumer: layerPlain },
  { id: "json", makeService: layerJsonService, makeEventConsumer: layerJson },
  { id: "verbose", makeService: layerVerboseService, makeEventConsumer: layerVerbose },
]) {
  test(`${contribution.id} satisfies renderer stream contracts`, async () => {
    await Effect.runPromise(
      makeRendererContractSuite({
        contribution,
        expectedCapabilities: (tty) =>
          contribution.id === "verbose" && tty
            ? RENDERER_CAPABILITIES_VERBOSE_TTY
            : RENDERER_CAPABILITIES_NONE,
      }).pipe(Effect.provide(EventService.layer)),
    );
  });
}
