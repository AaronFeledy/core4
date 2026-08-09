import { Layer } from "effect";

import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";

import { initApp } from "../cli/commands/init";

export const ScratchInitAppPortLive = Layer.succeed(ScratchInitAppPort, { initApp });
