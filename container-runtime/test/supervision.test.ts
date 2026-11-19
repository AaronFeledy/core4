import { expect, test } from "bun:test";
import { restartVerdict } from "../src/supervision.ts";

test.each([
  ["planned", undefined, "exited", undefined, "not-expected"],
  ["observed", undefined, "exited", undefined, "unknown"],
  ["observed", "", "exited", 7, "not-expected"],
  ["planned", "", "exited", 7, "unknown"],
  ["observed", "something-new", "exited", 7, "unknown"],
  ["planned", "no", "restarting", undefined, "expected"],
  ["planned", "always", "exited", 0, "expected"],
  ["observed", "unless-stopped", "dead", undefined, "expected"],
  ["observed", "no", "dead", undefined, "not-expected"],
  ["observed", "on-failure", "dead", 0, "unknown"],
  ["planned", "on-failure", "exited", 7, "expected"],
  ["observed", "on-failure", "exited", 0, "not-expected"],
  ["observed", "on-failure", "exited", undefined, "unknown"],
] as const)(
  "decides restart from %s %s in state %s with code %s",
  (source, policy, state, exitCode, expected) => {
    const input =
      source === "observed"
        ? { source, policy, state, exitCode }
        : {
            source,
            state,
            exitCode,
            service: { extensions: policy === undefined ? {} : { compose: { restart: policy } } },
          };
    expect(restartVerdict(input)).toBe(expected);
  },
);
