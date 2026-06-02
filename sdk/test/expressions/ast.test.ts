import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  ExpressionTemplate,
  type ExpressionTemplate as ExpressionTemplateType,
} from "@lando/sdk/expressions";

describe("ExpressionTemplate schema", () => {
  test("round-trips a recursive expression tree", () => {
    const template: ExpressionTemplateType = {
      whole: true,
      segments: [
        {
          kind: "InterpolationSegment",
          trimLeft: false,
          trimRight: true,
          expression: {
            kind: "Conditional",
            test: {
              kind: "Call",
              callee: "eq",
              args: [
                {
                  kind: "Path",
                  head: "env",
                  segments: [{ type: "prop", name: "APP_ENV" }],
                },
                { kind: "Literal", value: "local" },
              ],
            },
            consequent: {
              kind: "ArrayLiteral",
              elements: [{ kind: "Literal", value: 1 }],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [
                {
                  key: "fallback",
                  value: {
                    kind: "Path",
                    head: "vars",
                    segments: [
                      {
                        type: "dynamic",
                        expr: {
                          kind: "Path",
                          head: "env",
                          segments: [{ type: "prop", name: "LOOKUP_KEY" }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    };

    const encoded = Schema.encodeSync(ExpressionTemplate)(template);
    const decoded = Schema.decodeUnknownSync(ExpressionTemplate)(encoded);

    expect(decoded).toEqual(template);
  });
});
