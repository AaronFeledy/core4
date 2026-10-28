import { data } from "@actions/expressions";
import {
  isBasicExpression,
  isBoolean,
  isMapping,
  isNumber,
  isSequence,
  isString,
} from "@actions/workflow-parser";
import { NullToken } from "@actions/workflow-parser/templates/tokens/null-token";
import type { TemplateToken } from "@actions/workflow-parser/templates/tokens/template-token";
import { Effect } from "effect";
import { ExpressionLimit, type LanguageSource, languageError, languageSource } from "./errors.ts";
import {
  type ExpressionBudget,
  type ExpressionOptions,
  boundedUtf8Size,
  createExpressionBudget,
  evaluateExpressionWithBudget,
  expressionLimits,
  measureExpressionValue,
} from "./expressions.ts";

export const tokenSource = (token: TemplateToken, file: string): LanguageSource =>
  languageSource({
    file,
    ...(token.line === undefined ? {} : { line: token.line }),
    ...(token.col === undefined ? {} : { column: token.col }),
  });
export type TemplateOptions = ExpressionOptions & { readonly source: LanguageSource };
interface TemplateBudget {
  nodes: number;
  bytes: number;
  expression: ExpressionBudget;
}
const evaluateToken = (
  token: TemplateToken,
  context: data.Dictionary,
  options: TemplateOptions,
  budget: TemplateBudget,
): Effect.Effect<data.ExpressionData, import("./errors.ts").LanguageError> =>
  Effect.fnUntraced(function* () {
    const source = { ...options.source, ...tokenSource(token, options.source.file) };
    let result: data.ExpressionData;
    if (isBasicExpression(token)) {
      const { column, ...withoutColumn } = source;
      result = yield* evaluateExpressionWithBudget(
        token.expression,
        context,
        token.blockScalarHeader?.startsWith(">") ? withoutColumn : source,
        options,
        budget.expression,
      );
    } else if (isString(token)) result = new data.StringData(token.value);
    else if (isBoolean(token)) result = new data.BooleanData(token.value);
    else if (isNumber(token)) result = new data.NumberData(token.value);
    else if (isSequence(token)) {
      const values: data.ExpressionData[] = [];
      for (const value of token) values.push(yield* evaluateToken(value, context, options, budget));
      result = new data.Array(...values);
    } else if (isMapping(token)) {
      result = new data.Dictionary();
      for (const { key, value } of token) {
        const evaluated = yield* evaluateToken(key, context, options, budget);
        if (!evaluated.primitive) return yield* Effect.fail(languageError("template-key", source));
        result.add(evaluated.coerceString(), yield* evaluateToken(value, context, options, budget));
      }
    } else if (token instanceof NullToken) result = new data.Null();
    else return yield* Effect.fail(languageError("workflow-invalid", source));
    return yield* Effect.try({
      try: () => {
        const limits = { ...expressionLimits, ...options.limits };
        const measured = measureExpressionValue(result, limits);
        budget.nodes += measured.nodes;
        budget.bytes += measured.bytes;
        if (budget.nodes > limits.valueNodes || budget.bytes > limits.valueBytes) throw new ExpressionLimit();
        return result;
      },
      catch: () => languageError("expression-limit", source),
    });
  })();

export const evaluateTemplate = (
  token: TemplateToken,
  context: data.Dictionary,
  options: TemplateOptions,
): Effect.Effect<data.ExpressionData, import("./errors.ts").LanguageError> =>
  Effect.fnUntraced(function* () {
    const source = options.source;
    yield* Effect.try({
      try: () => {
        const limits = { ...expressionLimits, ...options.limits };
        for (const key of Object.keys(limits) as (keyof typeof limits)[])
          if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > expressionLimits[key])
            throw new ExpressionLimit();
        const pending = [{ token, depth: 1 }];
        let count = 0;
        let bytes = 0;
        while (pending.length) {
          const item = pending.pop();
          if (item === undefined) break;
          if (++count > limits.valueNodes || item.depth > limits.valueDepth) throw new ExpressionLimit();
          if (isMapping(item.token)) {
            if (item.token.count * 2 + count + pending.length > limits.valueNodes)
              throw new ExpressionLimit();
            for (const pair of item.token)
              pending.push(
                { token: pair.key, depth: item.depth + 1 },
                { token: pair.value, depth: item.depth + 1 },
              );
          } else if (isSequence(item.token)) {
            if (item.token.count + count + pending.length > limits.valueNodes) throw new ExpressionLimit();
            for (const child of item.token) pending.push({ token: child, depth: item.depth + 1 });
          } else if (isString(item.token))
            bytes += boundedUtf8Size(item.token.value, limits.valueBytes - bytes);
          else if (isBasicExpression(item.token))
            bytes += boundedUtf8Size(item.token.expression, limits.valueBytes - bytes);
          if (bytes > limits.valueBytes) throw new ExpressionLimit();
        }
      },
      catch: () => languageError("expression-limit", source),
    });
    return yield* evaluateToken(token, context, options, {
      nodes: 0,
      bytes: 0,
      expression: createExpressionBudget(),
    });
  })();
