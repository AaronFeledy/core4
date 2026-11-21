import { expect, test } from "bun:test";
import { LandofileAuthoringFragment, getJsonSchema } from "@lando/sdk/schema";
import Ajv2020 from "ajv/dist/2020.js";
import { Result, Schema } from "effect";

const artifact = await Bun.file(
  new URL("../../../dist/schemas/landofile-authoring-fragment.json", import.meta.url),
).json();
expect(artifact).toEqual(getJsonSchema("LandofileAuthoringFragment"));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(artifact);

test.each([
  { ports: [80, "8080:80"], decoder: true, published: true },
  {
    ports: [{ target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }],
    decoder: true,
    published: true,
  },
  {
    ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }],
    decoder: false,
    published: false,
  },
  { ports: null, decoder: false, published: false },
  { ports: [null], decoder: false, published: false },
  { ports: [{ target: null }], decoder: false, published: false },
  { ports: [{ target: -1 }], decoder: false, published: false },
])("published override ports agree with the decoder (%#)", ({ ports, decoder, published }) => {
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
  const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragment)(input, {
    onExcessProperty: "error",
  });
  expect(Result.isSuccess(decoded)).toBe(decoder);
  expect(validate(input)).toBe(published);
});
