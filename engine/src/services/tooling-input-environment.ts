import { Context, Effect } from "effect";

export const ToolingBooleanEnvironment = Context.Reference<Readonly<Record<string, boolean>>>(
  "@lando/engine/ToolingBooleanEnvironment",
  { defaultValue: () => ({}) },
);

export const environmentForRedaction = Effect.fnUntraced(function* (
  inherited: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string | undefined>> | undefined,
) {
  const booleans = yield* ToolingBooleanEnvironment;
  const environment = { ...inherited, ...explicit };
  for (const [name, value] of Object.entries(booleans)) {
    if (explicit !== undefined && Object.hasOwn(explicit, name) && explicit[name] === String(value))
      delete environment[name];
  }
  return environment;
});
