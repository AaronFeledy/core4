/**
 * `lando logs` — OCLIF wrapper.
 */
import { Effect, Stream } from "effect";

import { logsApp } from "../../commands/logs.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const logsSpec: LandoCommandSpec<void> = {
  id: "logs",
  summary: "Stream logs from the current app.",
  bootstrap: "app",
  // Streaming commands wrap the Stream into an Effect that runs to completion.
  run: () => logsApp().pipe(Stream.runForEach(() => Effect.void)),
};

export default class LogsCommand extends LandoCommandBase {
  static override description = logsSpec.summary;
  static override landoSpec: LandoCommandSpec = logsSpec;

  override async run(): Promise<void> {
    await this.runEffect(logsSpec);
  }
}
