import { expect, test } from "bun:test";
import { override, reset } from "@lando/sdk/landofile";
import { LandofileAuthoringFragment, LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Schema } from "effect";

test("fragment JSON transport restores the directive brand", () => {
  const wire = {
    services: {
      web: {
        routes: { _tag: "LandofileOverride", value: ["new.test"] },
        environment: { OLD: { _tag: "LandofileReset" } },
      },
    },
  };
  const decoded = Schema.decodeUnknownSync(LandofileAuthoringFragment)(JSON.parse(JSON.stringify(wire)), {
    onExcessProperty: "error",
  });
  expect(decoded).toEqual({
    services: { web: { routes: override(["new.test"]), environment: { OLD: reset() } } },
  });
  expect<unknown>(Schema.encodeSync(LandofileAuthoringFragment)(decoded)).toEqual(wire);
});

test("native authored mappings that resemble wire envelopes stay ordinary data", () => {
  const value = { "x-data": { _tag: "LandofileReset" } };
  const decoded = Schema.decodeUnknownSync(LandofileAuthoringFragmentNative)(value, {
    onExcessProperty: "error",
  });
  expect(decoded).toEqual(value);
  expect(Schema.encodeUnknownResult(LandofileAuthoringFragment)(decoded)._tag).toBe("Failure");
});
