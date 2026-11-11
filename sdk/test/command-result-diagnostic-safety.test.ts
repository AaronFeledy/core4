import { expect, test } from "bun:test";
import { taggedErrorJson } from "@lando/sdk/command-result";

test("typed diagnostic fields never invoke untrusted accessors or proxy traps", () => {
  let calls = 0;
  const issue = Object.defineProperty({}, "message", {
    enumerable: true,
    get: () => {
      calls++;
      return "unsafe";
    },
  });
  const steps = new Proxy([], {
    get: () => {
      calls++;
      return "unsafe";
    },
  });
  const diagnostic = taggedErrorJson({
    _tag: "Example",
    message: "Failed",
    remediation: "Repair configuration.",
    issues: [issue],
    steps,
  });
  expect(diagnostic).toEqual({ _tag: "Example", message: "Failed", remediation: "Repair configuration." });
  expect(calls).toBe(0);
});

test("does not invoke proxy traps on a wrapped cause", () => {
  let calls = 0;
  const cause = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        calls++;
        return undefined;
      },
    },
  );
  expect(taggedErrorJson({ _tag: "Outer", message: "Failed.", cause })).not.toHaveProperty("cause");
  expect(calls).toBe(0);
});
