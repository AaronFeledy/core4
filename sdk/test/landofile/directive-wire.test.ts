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
  const wire = Schema.encodeSync(LandofileAuthoringFragment)(decoded);
  expect(wire).toEqual({ "x-data": { _tag: "LandofileLiteral", value: value["x-data"] } });
  expect(Schema.decodeUnknownSync(LandofileAuthoringFragment)(JSON.parse(JSON.stringify(wire)))).toEqual(
    value,
  );
});

test("opaque nested directives survive JSON transport without consuming literal lookalikes", () => {
  // Given native operations and reserved-looking ordinary mappings below an opaque key.
  const native = {
    "x-data": {
      nested: reset(),
      list: [override({ old: reset() })],
      literal: {
        _tag: "LandofileLiteral",
        value: { _tag: "LandofileOverride", value: "ordinary" },
      },
    },
  };
  // When the authoring codec crosses a JSON boundary.
  const wire = Schema.encodeUnknownSync(LandofileAuthoringFragment)(native);
  const decoded = Schema.decodeUnknownSync(LandofileAuthoringFragment)(JSON.parse(JSON.stringify(wire)));
  // Then both branded operations and literal data retain their meaning.
  expect(decoded).toEqual(native);
});
