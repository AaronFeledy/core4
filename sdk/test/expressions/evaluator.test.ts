import { describe, expect, test } from "bun:test";
import { Either } from "effect";

import {
  type ExpressionContext,
  type ExpressionNode,
  type ExpressionTemplate,
  evaluateExpressionEither,
  evaluateTemplateEither,
  parseExpressionEither,
} from "@lando/sdk/expressions";

const filePath = "/app/.lando.yml";

const parseTemplate = (source: string): ExpressionTemplate => {
  const result = parseExpressionEither(source, { filePath });
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

const interpolationExpression = (source: string): ExpressionNode => {
  const template = parseTemplate(source);
  const segment = template.segments[0];
  expect(segment?.kind).toBe("InterpolationSegment");
  if (segment?.kind !== "InterpolationSegment") {
    throw new Error("expected interpolation segment");
  }
  return segment.expression;
};

const evaluateExpressionValue = (source: string, context: ExpressionContext = {}): unknown => {
  const result = evaluateExpressionEither(interpolationExpression(source), context, { filePath });
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

const evaluateTemplateValue = (source: string, context: ExpressionContext = {}): unknown => {
  const result = evaluateTemplateEither(parseTemplate(source), context, { filePath });
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

const evaluateExpressionFailure = (source: string, context: ExpressionContext = {}) => {
  const result = evaluateExpressionEither(interpolationExpression(source), context, { filePath });
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) {
    throw new Error("expected evaluation failure");
  }
  return result.left;
};

const evaluateTemplateFailure = (source: string, context: ExpressionContext = {}) => {
  const result = evaluateTemplateEither(parseTemplate(source), context, { filePath });
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) {
    throw new Error("expected template evaluation failure");
  }
  return result.left;
};

describe("evaluateExpression happy paths", () => {
  test("uses default for an unset env read", () => {
    expect(evaluateExpressionValue('{{ default(env.NOT_SET, "fallback") }}', { env: {} })).toBe("fallback");
  });

  test("keeps a set env value before default", () => {
    expect(
      evaluateExpressionValue('{{ default(env.APP_ENV, "fallback") }}', { env: { APP_ENV: "local" } }),
    ).toBe("local");
  });

  test("resolves secret references from the expression context", () => {
    expect(evaluateTemplateValue("${secret:API_KEY}", { secrets: { API_KEY: "s3cr3t" } })).toBe("s3cr3t");
  });

  test("reads app scope values", () => {
    expect(evaluateExpressionValue("{{ app.name }}", { app: { name: "demo" } })).toBe("demo");
  });

  test("gets a collection member", () => {
    expect(
      evaluateExpressionValue('{{ get(vars.config, "port") }}', { vars: { config: { port: 80 } } }),
    ).toBe(80);
  });

  test("applies string helpers", () => {
    expect(evaluateExpressionValue('{{ upper(trim(" hi ")) }}')).toBe("HI");
  });

  test("evaluates comparator calls and ternaries", () => {
    expect(
      evaluateExpressionValue('{{ app.replicas >= 2 ? "many" : "one" }}', { app: { replicas: 3 } }),
    ).toBe("many");
  });

  test("preserves whole-template numbers", () => {
    expect(evaluateTemplateValue("{{ 42 }}")).toBe(42);
  });

  test("preserves whole-template booleans", () => {
    expect(evaluateTemplateValue("{{ true }}")).toBe(true);
  });

  test("preserves whole-template arrays", () => {
    expect(evaluateTemplateValue("{{ [1, 2] }}")).toEqual([1, 2]);
  });

  test("preserves whole-template objects", () => {
    expect(evaluateTemplateValue("{{ { answer: 42 } }}")).toEqual({ answer: 42 });
  });

  test("renders mixed templates as strings", () => {
    expect(evaluateTemplateValue("answer={{ 42 }}")).toBe("answer=42");
  });

  test("expands plain shell parameters from context.env", () => {
    expect(evaluateTemplateValue("$APP_ENV", { env: { APP_ENV: "local" } })).toBe("local");
  });

  test("renders unset plain shell parameters as empty strings", () => {
    expect(evaluateTemplateValue("$NOT_SET", { env: {} })).toBe("");
  });

  test("uses default-empty shell words for empty values", () => {
    expect(evaluateTemplateValue("${EMPTY:-fallback}", { env: { EMPTY: "" } })).toBe("fallback");
  });

  test("keeps set-but-empty values for default-unset shell words", () => {
    expect(evaluateTemplateValue("${EMPTY-fallback}", { env: { EMPTY: "" } })).toBe("");
  });

  test("uses alt shell words for set non-empty values", () => {
    expect(evaluateTemplateValue("${APP_ENV:+alt}", { env: { APP_ENV: "local" } })).toBe("alt");
  });

  test("renders alt shell words as empty for unset values", () => {
    expect(evaluateTemplateValue("${NOT_SET:+alt}", { env: {} })).toBe("");
  });

  test("evaluates member access on a call result", () => {
    expect(evaluateExpressionValue(`{{ (fromJson('{"a":1}')).a }}`)).toBe(1);
  });
});

describe("evaluateExpression forbidden helpers", () => {
  for (const [helper, source] of [
    ["load", '{{ load("./x.json") }}'],
    ["import", '{{ import("./x.ts") }}'],
    ["which", '{{ which("docker") }}'],
    ["glob", '{{ glob("*.yml") }}'],
    ["fs.exists", '{{ fs.exists("./.lando.yml") }}'],
  ] as const) {
    test(`rejects ${helper}`, () => {
      const error = evaluateExpressionFailure(source);

      expect(error._tag).toBe("LandofileExpressionForbiddenError");
      if (error._tag === "LandofileExpressionForbiddenError") {
        expect(error.helper).toBe(helper);
      }
    });
  }
});

describe("evaluateExpression eval errors", () => {
  test("rejects unknown helpers", () => {
    expect(evaluateExpressionFailure("{{ nope() }}")._tag).toBe("LandofileExpressionEvalError");
  });

  for (const helper of ["yaml", "fromYaml", "fromToml"] as const) {
    test(`rejects unsupported ${helper} decoder`, () => {
      const error = evaluateExpressionFailure(`{{ ${helper}("x") }}`);

      expect(error._tag).toBe("LandofileExpressionEvalError");
      expect(error.message).toContain("not supported");
    });
  }

  test("rejects missing required helper values", () => {
    expect(evaluateExpressionFailure("{{ required(env.NOT_SET) }}", { env: {} })._tag).toBe(
      "LandofileExpressionEvalError",
    );
  });

  test("rejects missing required shell parameters", () => {
    expect(evaluateTemplateFailure("${NOT_SET:?required}", { env: {} })._tag).toBe(
      "LandofileExpressionEvalError",
    );
  });

  test("blocks proto-pollution traversal", () => {
    expect(evaluateExpressionFailure("{{ env.__proto__ }}", { env: {} })._tag).toBe(
      "LandofileExpressionEvalError",
    );
  });

  test("blocks constructor keys even when present in context", () => {
    expect(evaluateExpressionFailure("{{ env.constructor }}", { env: { constructor: "owned" } })._tag).toBe(
      "LandofileExpressionEvalError",
    );
  });

  test("does not leak secret values through errors", () => {
    const secret = "super-secret-value";
    const error = evaluateExpressionFailure("{{ nope(secrets.TOKEN) }}", { secrets: { TOKEN: secret } });

    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });
});
