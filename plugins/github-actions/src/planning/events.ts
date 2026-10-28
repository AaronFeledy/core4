import { data } from "@actions/expressions";
import { isMapping } from "@actions/workflow-parser";
import { Effect } from "effect";
import { EventError, eventError } from "../events/errors.ts";
import type { EventName, EventTrigger, InputDefinition } from "../events/index.ts";
import type { ParsedWorkflowLanguage } from "../language/parse.ts";
import { evaluateTemplate, tokenSource } from "../language/template.ts";

/** Convert only the original upstream `on` token, preserving authored defaults and filter order. */
export const workflowEventTriggers = Effect.fn("ActionsPlanning.workflowEventTriggers")(function* (
  parsed: ParsedWorkflowLanguage,
) {
  const token = isMapping(parsed.token) ? parsed.token.find("on") : undefined;
  if (token === undefined) return yield* Effect.fail(eventError("event-invalid", parsed.source));
  const value = yield* evaluateTemplate(token, new data.Dictionary(), {
    source: tokenSource(token, parsed.source.file),
    contextNames: [],
  });
  return yield* Effect.try({
    try: (): readonly EventTrigger[] => {
      const raw: unknown = JSON.parse(JSON.stringify(value, data.replacer));
      const declarations =
        typeof raw === "string"
          ? [[raw, null]]
          : Array.isArray(raw)
            ? raw.map((name) => [name, null])
            : raw !== null && typeof raw === "object"
              ? Object.entries(raw)
              : [];
      if (declarations.length === 0 || declarations.length > 100)
        throw eventError("event-invalid", tokenSource(token, parsed.source.file));
      return declarations.map(([name, settings]) => {
        if (!["push", "pull_request", "workflow_dispatch", "workflow_call", "schedule"].includes(name))
          throw eventError("event-invalid", tokenSource(token, parsed.source.file));
        if (name === "schedule") {
          if (
            !Array.isArray(settings) ||
            settings.some(
              (entry) =>
                entry === null ||
                typeof entry !== "object" ||
                Object.keys(entry).some((key) => key !== "cron"),
            )
          )
            throw eventError("schedule-unsupported", tokenSource(token, parsed.source.file));
        } else if (
          settings !== null &&
          settings !== undefined &&
          (typeof settings !== "object" || Array.isArray(settings))
        )
          throw eventError("event-invalid", tokenSource(token, parsed.source.file));
        const fields = (settings ?? {}) as Record<string, unknown>;
        const allowed =
          name === "push"
            ? ["branches", "branches-ignore", "tags", "tags-ignore", "paths", "paths-ignore"]
            : name === "pull_request"
              ? ["branches", "branches-ignore", "paths", "paths-ignore", "types"]
              : name === "workflow_dispatch"
                ? ["inputs"]
                : name === "workflow_call"
                  ? ["inputs", "secrets"]
                  : [];
        if (name !== "schedule" && Object.keys(fields).some((key) => !allowed.includes(key)))
          throw eventError("event-invalid", tokenSource(token, parsed.source.file));
        const trigger: EventTrigger = {
          name: name as EventName,
          ...(fields.branches === undefined ? {} : { branches: fields.branches as string[] }),
          ...(fields["branches-ignore"] === undefined
            ? {}
            : { branchesIgnore: fields["branches-ignore"] as string[] }),
          ...(fields.tags === undefined ? {} : { tags: fields.tags as string[] }),
          ...(fields["tags-ignore"] === undefined ? {} : { tagsIgnore: fields["tags-ignore"] as string[] }),
          ...(fields.paths === undefined ? {} : { paths: fields.paths as string[] }),
          ...(fields["paths-ignore"] === undefined
            ? {}
            : { pathsIgnore: fields["paths-ignore"] as string[] }),
          ...(fields.types === undefined ? {} : { types: fields.types as string[] }),
        };
        if (name === "schedule")
          return { ...trigger, schedules: (settings as { cron: string }[]).map((entry) => entry.cron) };
        if (name !== "workflow_dispatch" && name !== "workflow_call") return trigger;
        const definitions = (fields.inputs ?? {}) as Record<string, Record<string, unknown>>;
        for (const definition of Object.values(definitions))
          if (
            Object.keys(definition).some(
              (key) => !["description", "type", "required", "default", "options"].includes(key),
            )
          )
            throw eventError("event-invalid", tokenSource(token, parsed.source.file));
        if (fields.secrets !== undefined)
          for (const secret of Object.values(fields.secrets as Record<string, Record<string, unknown>>))
            if (Object.keys(secret).some((key) => !["description", "required"].includes(key)))
              throw eventError("event-invalid", tokenSource(token, parsed.source.file));
        const inputs = Object.fromEntries(
          Object.entries(definitions).map(([key, definition]) => [
            key,
            {
              type: (definition.type ?? "string") as InputDefinition["type"],
              ...(definition.required === undefined ? {} : { required: definition.required as boolean }),
              ...(definition.default === undefined
                ? {}
                : { default: definition.default as string | number | boolean }),
              ...(definition.options === undefined ? {} : { options: definition.options as string[] }),
            },
          ]),
        );
        return {
          ...trigger,
          inputs,
          ...(fields.secrets === undefined
            ? {}
            : { secrets: fields.secrets as Record<string, { required?: boolean }> }),
        };
      });
    },
    catch: (error) =>
      error instanceof EventError
        ? error
        : eventError("event-invalid", tokenSource(token, parsed.source.file)),
  });
});
