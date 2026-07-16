import { appendFileSync } from "node:fs";

const tracePath = process.env.LANDO_OPENTUI_PROBE_TRACE;
const failOnAttempt = process.env.LANDO_OPENTUI_PROBE_FAIL === "1";

if (tracePath !== undefined) {
  Reflect.set(globalThis, Symbol.for("@lando/test/opentui-loader-probe"), (event: unknown): void => {
    appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
    if (
      failOnAttempt &&
      typeof event === "object" &&
      event !== null &&
      Reflect.get(event, "phase") === "attempt"
    ) {
      throw new Error("Forced OpenTUI loader failure from acceptance preload.");
    }
  });
}
