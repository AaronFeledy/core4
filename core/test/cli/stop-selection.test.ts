import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { stopOptionsFromInput, stopSpec } from "../../src/cli/command-specs/app/stop.ts";
import { validateCliFlagValues } from "../../src/cli/flag-value-validation";

test("stop options omit services when the flag is absent", () => {
  expect(stopOptionsFromInput({ flags: {} })).toEqual({});
  expect(stopOptionsFromInput({ flags: { service: ["web"] } })).toEqual({
    services: [ServiceName.make("web")],
  });
});

test("an empty service name reaches the operation instead of widening stop to the whole app", () => {
  expect(stopOptionsFromInput({ flags: { service: [""] } })).toEqual({ services: [ServiceName.make("")] });
});

for (const argv of [["--service", ""], ["--service", "web", "-s", ""], ["--service="]]) {
  test(`CLI rejects empty stop selection ${JSON.stringify(argv)}`, () => {
    expect(validateCliFlagValues(argv, stopSpec.flags ?? {})).toMatchObject({
      _tag: "MalformedCliFlagValueError",
      flag: "service",
      issue: "empty",
    });
  });
}
