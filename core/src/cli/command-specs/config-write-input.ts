import type { ValueType } from "@lando/engine/config-write/write-core";
import { booleanFlag, specArgsOf, specFlagsOf, stringFlag } from "../spec/input-coercion";

export const configWriteOptionsFromInput = <F extends string>(
  input: unknown,
  options: { readonly formats: ReadonlyArray<F>; readonly defaultFormat?: F },
) => {
  const args = specArgsOf(input);
  const flags = specFlagsOf(input);
  const subcommand = stringFlag(args, "subcommand");
  const key = stringFlag(args, "key");
  const value = stringFlag(args, "value");
  const type = ["string", "number", "boolean", "json", "yaml"].find(
    (value): value is ValueType => value === flags.type,
  );
  const format = options.formats.find((value) => value === flags.format) ?? options.defaultFormat;
  const path = stringFlag(flags, "path");
  const editor = stringFlag(flags, "editor");
  return {
    ...(subcommand === undefined || subcommand.length === 0 ? {} : { subcommand }),
    ...(key === undefined ? {} : { key }),
    ...(value === undefined ? {} : { value }),
    ...(type === undefined ? {} : { type }),
    ...(format === undefined ? {} : { format }),
    ...(path === undefined ? {} : { path }),
    ...(editor === undefined ? {} : { editor }),
    ...(booleanFlag(flags, "dry-run") ? { dryRun: true } : {}),
  };
};
