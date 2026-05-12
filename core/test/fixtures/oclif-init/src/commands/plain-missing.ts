import { Command } from "@oclif/core";

import { events } from "../events.ts";

export default class PlainMissingCommand extends Command {
  static override description = "Plain OCLIF command missing bootstrap fixture.";

  override async run(): Promise<void> {
    events.push("plain-missing-run");
  }
}
