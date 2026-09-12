import type { CompiledCommand, OclifArgDefinition, OclifFlagDefinition } from "./compiled-argv";
import { universalFormatFlagDefs } from "./format-flags";
import { type HelpAliasPolicy, typeableName } from "./help-names";
import { bold, cyan, dim } from "./help-style";
import { resolveTopLevelAliases } from "./spec/command-base";

const UNIVERSAL_FLAGS = new Set(["format", "json", "jq"]);
const GLOBAL_FLAGS_FOOTER =
  "Global flags (--format, --json [fields], --jq, --renderer, --verbose, --log-level, --debug) work on every command.";

export type CommandHelpStatus =
  | { readonly kind: "implemented" }
  | { readonly kind: "deferred"; readonly plan: { readonly phase: string } }
  | { readonly kind: "embedding-exempt" };

export type CommandHelpSpec = {
  readonly id: string;
  readonly summary: string;
  readonly topLevelAlias?: Parameters<typeof resolveTopLevelAliases>[0]["topLevelAlias"];
  readonly aliases?: Parameters<typeof resolveTopLevelAliases>[0]["aliases"];
  readonly args?: CompiledCommand["args"];
  readonly flags?: CompiledCommand["flags"];
  readonly examples?: ReadonlyArray<string>;
  readonly usage?: string;
  readonly strict?: boolean;
};

export type CommandHelpEntry = {
  readonly spec: CommandHelpSpec;
  readonly status: CommandHelpStatus;
};

export type CommandHelpOptions = {
  readonly styled?: boolean;
  readonly aliasPolicy?: HelpAliasPolicy;
};

export type ToolingHelpInput = {
  readonly flags: readonly {
    readonly name: string;
    readonly alias?: string;
    readonly boolean: boolean;
    readonly choices?: readonly string[];
    readonly default?: string | boolean;
    readonly required: boolean;
    readonly description?: string;
  }[];
  readonly args: readonly {
    readonly name: string;
    readonly order: number;
    readonly choices?: readonly string[];
    readonly default?: string;
    readonly required: boolean;
    readonly description?: string;
  }[];
};

export type ToolingHelpEntry = {
  readonly id: string;
  readonly summary: string;
  readonly hidden?: boolean;
  readonly service?: string;
  readonly input?: ToolingHelpInput;
};

type HelpStyle = {
  readonly heading: (text: string) => string;
  readonly command: (text: string) => string;
  readonly extra: (text: string) => string;
};

const styledHelp: HelpStyle = { heading: bold, command: cyan, extra: dim };
const plainHelp: HelpStyle = {
  heading: (text) => text,
  command: (text) => text,
  extra: (text) => text,
};

const helpStyle = (styled: boolean): HelpStyle => (styled ? styledHelp : plainHelp);

const typeableFor = (
  canonicalId: string,
  builtInAliases: ReadonlyArray<string>,
  aliasPolicy?: HelpAliasPolicy,
  implicitNamespaceStrip = false,
) =>
  typeableName({
    canonicalId,
    builtInAliases,
    implicitNamespaceStrip,
    ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
  });

export const helpFlagToken = (name: string, definition: OclifFlagDefinition): string => {
  const short = definition.char === undefined ? "" : `, -${definition.char}`;
  return `--${definition.name ?? name}${short}`;
};

export const helpArgToken = (name: string, definition: OclifArgDefinition, repeatable: boolean): string => {
  const label = `${name.toUpperCase()}${repeatable ? "..." : ""}`;
  return definition.required === true ? `<${label}>` : `[${label}]`;
};

export const renderCommandUsage = (
  name: string,
  command: { readonly args?: CompiledCommand["args"]; readonly strict?: boolean; readonly usage?: string },
): string => {
  if (command.usage !== undefined && command.usage.length > 0) return `${name} ${command.usage}`;
  const definitions = Object.entries(command.args ?? {});
  const repeatable = command.strict === false && definitions.length === 1;
  const args = definitions.map(([argName, definition]) => helpArgToken(argName, definition, repeatable));
  return args.length === 0 ? name : `${name} ${args.join(" ")}`;
};

export const renderCommandHelpFlags = (command: {
  readonly flags?: CompiledCommand["flags"];
}): ReadonlyArray<string> => {
  const entries = Object.entries({ ...universalFormatFlagDefs, ...(command.flags ?? {}) })
    .filter(([name]) => !UNIVERSAL_FLAGS.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return [];
  const lines = ["", "FLAGS"];
  for (const [name, definition] of entries) {
    const options = definition.options === undefined ? "" : ` (${definition.options.join(", ")})`;
    const description = definition.description === undefined ? "" : ` ${definition.description}${options}`;
    lines.push(`  ${helpFlagToken(name, definition)}${description}`);
  }
  return lines;
};

const aliasLines = (extras: ReadonlyArray<string>, style: HelpStyle): ReadonlyArray<string> =>
  extras.length === 0 ? [] : ["", style.heading("ALIASES"), `  ${style.extra(extras.join(", "))}`];

const deferredStatusLines = (status: CommandHelpStatus, style: HelpStyle): ReadonlyArray<string> => {
  switch (status.kind) {
    case "deferred":
      return ["", style.heading("STATUS"), `  Planned for Lando ${status.plan.phase}.`];
    case "implemented":
    case "embedding-exempt":
      return [];
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const exampleLines = (
  examples: ReadonlyArray<string> | undefined,
  style: HelpStyle,
): ReadonlyArray<string> =>
  examples === undefined || examples.length === 0
    ? []
    : ["", style.heading("EXAMPLES"), ...examples.map((example) => `  ${example}`)];

export const renderCommandHelp = (entry: CommandHelpEntry, options?: CommandHelpOptions): string => {
  const style = helpStyle(options?.styled === true);
  const names = typeableFor(
    entry.spec.id,
    resolveTopLevelAliases({
      id: entry.spec.id,
      ...(entry.spec.topLevelAlias === undefined ? {} : { topLevelAlias: entry.spec.topLevelAlias }),
      ...(entry.spec.aliases === undefined ? {} : { aliases: entry.spec.aliases }),
    }),
    options?.aliasPolicy,
  );
  const usage = renderCommandUsage(names.primary, entry.spec);
  const flagLines = renderCommandHelpFlags(entry.spec).map((line) =>
    line === "FLAGS" ? style.heading(line) : line,
  );
  return [
    entry.spec.summary,
    "",
    style.heading("USAGE"),
    `  ${style.command(`lando ${usage}`)}`,
    ...aliasLines(names.extras, style),
    ...deferredStatusLines(entry.status, style),
    ...flagLines,
    ...exampleLines(entry.spec.examples, style),
    "",
    GLOBAL_FLAGS_FOOTER,
  ].join("\n");
};

type HelpItemMeta = {
  readonly description?: string;
  readonly choices?: readonly string[];
  readonly default?: string | boolean;
  readonly required: boolean;
};

const helpItemMeta = (item: HelpItemMeta): string => {
  const description = item.description === undefined ? "" : ` ${item.description}`;
  const choices =
    item.choices === undefined || item.choices.length === 0 ? "" : ` (${item.choices.join(", ")})`;
  const defaultText = item.default === undefined ? "" : ` [default: ${String(item.default)}]`;
  const requiredText = item.required ? " [required]" : "";
  return `${description}${choices}${defaultText}${requiredText}`;
};

const toolingSection = (title: string, rows: readonly string[], style: HelpStyle): readonly string[] =>
  rows.length === 0 ? [] : ["", style.heading(title), ...rows];

export const renderToolingHelp = (entry: ToolingHelpEntry, options?: CommandHelpOptions): string => {
  const style = helpStyle(options?.styled === true);
  const names = typeableFor(entry.id, [], options?.aliasPolicy, true);
  const input = entry.input;
  const usage =
    input === undefined
      ? `lando ${names.primary} [args...]`
      : `lando ${names.primary}${input.flags.length === 0 ? "" : " [flags]"}${
          input.args.length === 0
            ? ""
            : ` ${input.args
                .map((arg) => (arg.required ? `<${arg.name.toUpperCase()}>` : `[${arg.name.toUpperCase()}]`))
                .join(" ")}`
        }`;
  const flagRows =
    input === undefined
      ? []
      : input.flags.map((flag) => {
          const alias = flag.alias === undefined ? "" : `, -${flag.alias}`;
          return `  --${flag.name}${alias}${helpItemMeta(flag)}`;
        });
  const argRows = input === undefined ? [] : input.args.map((arg) => `  ${arg.name}${helpItemMeta(arg)}`);
  const lines = [
    entry.summary,
    "",
    style.heading("USAGE"),
    `  ${style.command(usage)}`,
    ...aliasLines(names.extras, style),
    ...toolingSection("FLAGS", flagRows, style),
    ...toolingSection("ARGUMENTS", argRows, style),
  ];
  if (entry.service !== undefined) lines.push("", `Runs in service ${entry.service}`);
  return lines.join("\n");
};
