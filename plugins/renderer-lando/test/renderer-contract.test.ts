import { test } from "bun:test";
import * as EventService from "@lando/engine/services/event-service";
import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_TTY } from "@lando/sdk/renderer";
import { makeRendererContractSuite } from "@lando/sdk/test";
import { Effect } from "effect";
import { landoRendererContribution } from "../src/renderer-runtime.ts";

test("lando satisfies renderer stream contracts", async () => {
  await Effect.runPromise(
    makeRendererContractSuite({
      contribution: landoRendererContribution,
      expectedCapabilities: (tty) => (tty ? RENDERER_CAPABILITIES_TTY : RENDERER_CAPABILITIES_NONE),
    }).pipe(Effect.provide(EventService.layer)),
  );
});
