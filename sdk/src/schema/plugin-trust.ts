import { Schema } from "effect";

export const isSortedUniquePluginTrustList = (values: ReadonlyArray<string>): boolean =>
  values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || previous < value;
  }) && new Set(values).size === values.length;

export const PluginTrustList = Schema.Array(Schema.String).pipe(
  Schema.filter(isSortedUniquePluginTrustList, {
    message: () => "Trust entries must be sorted and unique.",
    jsonSchema: {},
  }),
);

export const PluginTrustState = Schema.Struct({
  trustedPlugins: PluginTrustList,
  trustedAuthoringRoots: PluginTrustList,
}).annotations({ identifier: "PluginTrustState" });

export type PluginTrustState = typeof PluginTrustState.Type;
