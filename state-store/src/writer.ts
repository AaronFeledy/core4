import { Context, Effect } from "effect";

export type StateWriterOptions = { readonly writer?: string };

// Only host composition sets this override; it is not part of the bucket spec plugins control.
export const PluginStateWriter = Context.Reference<string | undefined>(
  "@lando/state-store/PluginStateWriter",
  {
    defaultValue: () => undefined,
  },
);

export const resolveStateWriter = (options: StateWriterOptions) =>
  Effect.map(PluginStateWriter, (override) => override ?? options.writer);
