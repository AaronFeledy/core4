import { expect, test } from "bun:test";
import { LandofileAuthoringFragment, getJsonSchema } from "@lando/sdk/schema";
import Ajv2020 from "ajv/dist/2020.js";
import { Result, Schema } from "effect";
import { ajvOptions, parseOptions } from "./landofile-parity-harness.ts";

const artifact = getJsonSchema("LandofileAuthoringFragment");
const snapshot = await Bun.file(
  new URL("../../../dist/schemas/landofile-authoring-fragment.json", import.meta.url),
).json();
expect(snapshot).toEqual(artifact);

const validate = new Ajv2020(ajvOptions).compile(artifact);
const decode = Schema.decodeUnknownResult(LandofileAuthoringFragment);

const cases = [
  { ports: [80, "8080:80"], accepted: true },
  { ports: [{ target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }], accepted: true },
  { ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }], accepted: false },
  { ports: null, accepted: false },
  { ports: [null], accepted: false },
  { ports: [{ target: null }], accepted: false },
  { ports: [{ target: -1 }], accepted: false },
] as const;

test.each(cases)("published override ports agree with the decoder (%#)", ({ ports, accepted }) => {
  const input = {
    services: {
      _tag: "LandofileOverride",
      value: {
        web: {
          _tag: "LandofileOverride",
          value: { ports: { _tag: "LandofileOverride", value: ports } },
        },
      },
    },
  };
  const decoded = Result.isSuccess(decode(input, parseOptions));
  const published = !!validate(input);
  expect({ decode: decoded, published }, JSON.stringify(ports)).toEqual({
    decode: accepted,
    published: accepted,
  });
});
