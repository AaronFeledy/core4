import { NoOperationTraceWriter, convertWorkflowTemplate, parseWorkflow } from "@actions/workflow-parser";
import { parseAction } from "@actions/workflow-parser/actions/action-parser";
import { getActionSchema } from "@actions/workflow-parser/actions/action-schema";
import { convertActionTemplate } from "@actions/workflow-parser/actions/action-template";
import { ErrorPolicy } from "@actions/workflow-parser/model/convert";
import {
  TemplateContext,
  TemplateValidationErrors,
} from "@actions/workflow-parser/templates/template-context";
import { getWorkflowSchema } from "@actions/workflow-parser/workflows/workflow-schema";
import { Effect } from "effect";
import { limits } from "../diagnostics.ts";
import { LanguageError, languageError, languageSource } from "./errors.ts";
import { preflightLanguage } from "./preflight.ts";

// One upstream token reader for inspection and bounded pure planning. The caller
// selects and completes its explicit structural policy before supplying this guard.
export const readLanguageTokens = (
  name: string,
  content: string,
  kind: "workflow" | "action",
  guard: ReturnType<typeof preflightLanguage>,
) => {
  const context = new TemplateContext(
    new TemplateValidationErrors(limits.errors + 1, 200),
    kind === "workflow" ? getWorkflowSchema() : getActionSchema(),
    new NoOperationTraceWriter(),
  );
  const result =
    kind === "workflow" ? parseWorkflow({ name, content }, context) : parseAction({ name, content }, context);
  return { ...result, source: languageSource({ file: name }), ...guard };
};
const parse = (name: string, content: string, kind: "workflow" | "action") =>
  Effect.try({
    try: () => {
      const guard = preflightLanguage(name, content, "bounded-language");
      const result = readLanguageTokens(name, content, kind, guard);
      const context = result.context;
      const first = context.errors.getErrors()[0];
      if (first !== undefined || result.value === undefined) {
        // Upstream diagnostic text is inspected only to classify a fixed code, never emitted.
        const code = first?.message.includes("already defined")
          ? "workflow-duplicate-key"
          : "workflow-invalid";
        throw languageError(code, { file: name, ...(first?.range?.start ?? {}) });
      }
      return { token: result.value, context, source: languageSource({ file: name }), ...guard };
    },
    catch: (error) =>
      error instanceof LanguageError ? error : languageError("parser-failure", { file: name }),
  });
export const parseWorkflowLanguage = Effect.fnUntraced(function* (name: string, content: string) {
  const result = yield* parse(name, content, "workflow");
  const workflow = yield* Effect.tryPromise({
    try: () =>
      convertWorkflowTemplate(result.context, result.token, undefined, {
        fetchReusableWorkflowDepth: 0,
        errorPolicy: ErrorPolicy.TryConversion,
      }),
    catch: () => languageError("workflow-invalid", { file: name }),
  });
  if (workflow === undefined || result.context.errors.count > 0)
    return yield* Effect.fail(languageError("workflow-invalid", { file: name }));
  return {
    source: result.source,
    token: result.token,
    workflow,
    sourceIndex: result.sourceIndex,
    aliasProvenance: result.aliasProvenance,
  };
});
export const parseActionLanguage = Effect.fnUntraced(function* (name: string, content: string) {
  const result = yield* parse(name, content, "action");
  const action = yield* Effect.try({
    try: () => convertActionTemplate(result.context, result.token),
    catch: () => languageError("action-invalid", { file: name }),
  });
  if (result.context.errors.count > 0)
    return yield* Effect.fail(languageError("action-invalid", { file: name }));
  return {
    source: result.source,
    token: result.token,
    action,
    sourceIndex: result.sourceIndex,
    aliasProvenance: result.aliasProvenance,
  };
});
export type ParsedWorkflowLanguage = Effect.Success<ReturnType<typeof parseWorkflowLanguage>>;
export type ParsedActionLanguage = Effect.Success<ReturnType<typeof parseActionLanguage>>;
