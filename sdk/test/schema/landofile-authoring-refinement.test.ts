import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import * as Public from "@lando/sdk/schema";

const producer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-demo",
  recipeId: "demo",
  manifestVersion: "1.0.0",
  contentDigest: `sha256:${"a".repeat(64)}`,
} as const;

const authoringDecoders = [
  ["complete shape", Schema.decodeUnknownEither(Public.LandofileAuthoringShape)],
  ["fragment", Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)],
] as const;

const provenanceWithServices = (services: Readonly<Record<string, string>>) => ({
  recipe: {
    id: "demo",
    version: "1.0.0",
    producer,
    options: {},
    services,
  },
});

describe("authoring container refinements", () => {
  test.each(authoringDecoders)(
    "rejects duplicate literal service targets alongside an expression in the %s",
    (_name, decode) => {
      // Given
      const input = provenanceWithServices({
        a: "same",
        b: "same",
        c: "{{ env.SERVICE }}",
      });

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );

  test.each(authoringDecoders)(
    "accepts service target equality that depends only on expressions in the %s",
    (_name, decode) => {
      // Given
      const input = provenanceWithServices({
        a: "{{ env.SERVICE }}",
        b: "{{ env.SERVICE }}",
      });

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Right");
    },
  );
});
