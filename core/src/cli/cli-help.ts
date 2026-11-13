import type { CommandIndexEntry } from "@lando/engine/cache/command-index";
import type { ToolingInputDeclaration, ToolingRunSummary } from "@lando/sdk/schema";
import { argStdioDescription } from "./arg-stdio";
import type { OclifArgDefinition, OclifFlagDefinition } from "./compiled-argv";
import { commandOwnedLandoFlags, specOwnerPolicy } from "./flag-claims";
import {
  type OptInResultFormat,
  UNIVERSAL_FORMAT_FLAG_NAMES,
  commandResultFormats,
  formatFlagDefsForCommand,
} from "./format-flags";
import { type HelpAliasPolicy, typeableName } from "./help-names";
import { bold, cyan, dim } from "./help-style";
import { LANDO_FLAGS, type LandoFlag, type LandoFlagMatch, landoFlagFooterLabels } from "./lando-flags";
import { resolveTopLevelAliases } from "./spec/command-base";
import { toolingRunHelp } from "./tooling-run-help";

/** The last line of a command page: where Lando reads its own flags for this command's tail. */
const FORMAT_FLAG_LABEL = "--format";
const placementFooter = (
  tail: "none" | "command" | "all",
  command: { readonly resultFormats?: ReadonlyArray<OptInResultFormat> },
  name: string,
): string => {
  const labels = landoFlagFooterLabels().map((label) =>
    label === FORMAT_FLAG_LABEL ? `${label} (${commandResultFormats(command).join(", ")})` : label,
  );
  const list = `Global flags (${labels.join(", ")})`;
  switch (tail) {
    case "none":
      return `${list} work anywhere before \`--\`.`;
    case "command":
      return `${list} go before the command to run, which receives everything from there on. For example: \`lando ${name} --format=json <command>\`.`;
    case "all":
      return `${list} go only before the command name. For example: \`lando --format=json ${name} <args...>\`.`;
    default:
      return tail satisfies never;
  }
};

export type CommandHelpStatus =
  | { readonly kind: "implemented" }
  | { readonly kind: "deferred"; readonly plan: { readonly summary: string } }
  | { readonly kind: "embedding-exempt" };

export type CommandHelpSpec = {
  readonly id: string;
  readonly summary: string;
  readonly topLevelAlias?: Parameters<typeof resolveTopLevelAliases>[0]["topLevelAlias"];
  readonly aliases?: Parameters<typeof resolveTopLevelAliases>[0]["aliases"];
  readonly args?: Readonly<
    Record<
      string,
      OclifArgDefinition &
        Pick<OclifFlagDefinition, "description" | "options"> & { readonly stdio?: "stdin" | "stdout" }
    >
  >;
  readonly flags?: Readonly<Record<string, OclifFlagDefinition>>;
  readonly examples?: ReadonlyArray<string>;
  readonly usage?: string;
  readonly strict?: boolean;
  readonly resultFormats?: ReadonlyArray<OptInResultFormat>;
};

export type CommandHelpEntry = {
  readonly spec: CommandHelpSpec;
  readonly status: CommandHelpStatus;
};

export type CommandHelpOptions = {
  readonly styled?: boolean;
  readonly aliasPolicy?: HelpAliasPolicy;
};

export type ToolingHelpInput = ToolingInputDeclaration;

export type ToolingHelpEntry = {
  readonly id: string;
  readonly summary: string;
  readonly hidden?: boolean;
  readonly service?: string;
  readonly input?: ToolingHelpInput;
  readonly wrapper?: true;
  readonly source?: "bun-script";
  readonly runs?: ToolingRunSummary;
  readonly loadError?: NonNullable<CommandIndexEntry["loadError"]>;
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

const landoFlag = (spelling: string) => LANDO_FLAGS.find((flag) => flag.spelling === spelling);

/** `--format=<value>` for a flag that takes a value, the bare spelling otherwise. */
const landoFlagUsage = (flag: Pick<LandoFlag, "spelling" | "arity">): string =>
  flag.arity === "value" ? `${flag.spelling}=<value>` : flag.spelling;

/** Reserved spellings name no Lando feature, so only the rest are worth a placement line. */
const sharedFlagLine = (spellings: ReadonlyArray<string>, name: string): string | undefined => {
  const flags = spellings.flatMap((spelling) => {
    const flag = landoFlag(spelling);
    return flag === undefined || flag.role === "reserved" ? [] : [flag];
  });
  const shared = flags.map((flag) => flag.spelling);
  const [firstFlag] = flags;
  if (firstFlag === undefined) return undefined;
  const first = firstFlag.spelling;
  const example = landoFlagUsage(firstFlag);
  const subject =
    shared.length === 1
      ? `\`${first}\` after \`${name}\` is this command's flag`
      : `${shared.map((spelling) => `\`${spelling}\``).join(", ")} after \`${name}\` are this command's flags`;
  return `${subject}. Put Lando's own before the name, as in \`lando ${example} ${name}\`.`;
};

const sharedFlagHint = (input: ToolingInputDeclaration | undefined, name: string): string | undefined =>
  sharedFlagLine(
    (input?.flags ?? []).flatMap((flag) => [
      `--${flag.name}`,
      ...(flag.alias === undefined ? [] : [`-${flag.alias}`]),
    ]),
    name,
  );

/**
 * Ownership guidance appended to a selection error for a flag typed after a
 * task name: how to pass it to the command, how to make the task read it, and
 * where Lando's own goes.
 */
export const selectionOwnershipHint = (match: LandoFlagMatch, taskName: string): string => {
  const { spelling } = match.flag;
  const typed =
    match.value === undefined
      ? spelling
      : match.attached
        ? `${spelling}=${match.value}`
        : `${spelling} ${match.value}`;
  const landoPlacement =
    match.flag.role === "selection"
      ? ` Lando's own \`${spelling}\` also works before the name: \`lando ${landoFlagUsage(match.flag)} ${taskName}\`.`
      : "";
  return `\`${spelling}\` after \`${taskName}\` is read by Lando. To pass it to the command, run \`lando ${taskName} -- ${typed}\`, declare a \`${spelling.replace(/^-+/u, "")}\` flag on the task, or set \`wrapper: true\` if the task wraps one CLI tool.${landoPlacement}`;
};

export const helpFlagToken = (name: string, definition: OclifFlagDefinition): string => {
  const short = definition.char === undefined ? "" : `, -${definition.char}`;
  const value =
    definition.type === "boolean" ? "" : definition.valueType === "integer" ? " <integer>" : " <value>";
  return `--${definition.name ?? name}${short}${value}`;
};

export const helpArgToken = (name: string, definition: OclifArgDefinition, repeatable: boolean): string => {
  const label = `${name.toUpperCase()}${repeatable ? "..." : ""}`;
  return definition.required === true ? `<${label}>` : `[${label}]`;
};

export const renderCommandUsage = (
  name: string,
  command: Pick<CommandHelpSpec, "args" | "strict" | "usage">,
): string => {
  if (command.usage !== undefined && command.usage.length > 0) return `${name} ${command.usage}`;
  const definitions = Object.entries(command.args ?? {});
  const repeatable = command.strict === false && definitions.length === 1;
  const args = definitions.map(([argName, definition]) => helpArgToken(argName, definition, repeatable));
  return args.length === 0 ? name : `${name} ${args.join(" ")}`;
};

export const renderCommandHelpFlags = (command: {
  readonly flags?: CommandHelpSpec["flags"];
  readonly resultFormats?: ReadonlyArray<OptInResultFormat>;
}): ReadonlyArray<string> => {
  const entries = Object.entries(formatFlagDefsForCommand(command))
    .filter(([name]) => !UNIVERSAL_FORMAT_FLAG_NAMES.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return [];
  const lines = ["", "FLAGS"];
  for (const [name, definition] of entries) {
    const options = definition.options === undefined ? "" : ` (${definition.options.join(", ")})`;
    const description = definition.description === undefined ? "" : ` ${definition.description}`;
    lines.push(`  ${helpFlagToken(name, definition)}${description}${options}`);
  }
  return lines;
};

const aliasLines = (extras: ReadonlyArray<string>, style: HelpStyle): ReadonlyArray<string> =>
  extras.length === 0 ? [] : ["", style.heading("ALIASES"), `  ${style.extra(extras.join(", "))}`];

const deferredStatusLines = (status: CommandHelpStatus, style: HelpStyle): ReadonlyArray<string> => {
  switch (status.kind) {
    case "deferred":
      return ["", style.heading("STATUS"), `  ${status.plan.summary}`];
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
  const policy = specOwnerPolicy(entry.spec, formatFlagDefsForCommand(entry.spec));
  const owned = commandOwnedLandoFlags(policy);
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
  const sharedLine = sharedFlagLine(owned, names.primary);
  const argRows = Object.entries(entry.spec.args ?? {}).map(([name, arg]) => {
    const description = argStdioDescription(arg);
    return `  ${name}${helpItemMeta({
      ...(description === undefined ? {} : { description }),
      ...(arg.options === undefined ? {} : { choices: arg.options }),
      required: arg.required === true,
      sensitive: false,
    })}`;
  });
  return [
    entry.spec.summary,
    "",
    style.heading("USAGE"),
    `  ${style.command(`lando ${usage}`)}`,
    ...aliasLines(names.extras, style),
    ...deferredStatusLines(entry.status, style),
    ...flagLines,
    ...helpSection("ARGUMENTS", argRows, style),
    ...exampleLines(entry.spec.examples, style),
    "",
    placementFooter(policy.tail, entry.spec, names.primary),
    ...(sharedLine === undefined ? [] : ["", sharedLine]),
  ].join("\n");
};

type HelpItemMeta = {
  readonly description?: string;
  readonly choices?: readonly string[];
  readonly default?: string | boolean;
  readonly required: boolean;
  readonly sensitive: boolean;
};

const helpItemMeta = (item: HelpItemMeta): string => {
  const description = item.description === undefined ? "" : ` ${item.description}`;
  const choices =
    item.choices === undefined || item.choices.length === 0 ? "" : ` (${item.choices.join(", ")})`;
  const defaultText = item.default === undefined ? "" : ` [default: ${String(item.default)}]`;
  const requiredText = item.required ? " [required]" : "";
  return `${description}${choices}${defaultText}${requiredText}${item.sensitive ? " [sensitive]" : ""}`;
};

const helpSection = (title: string, rows: readonly string[], style: HelpStyle): readonly string[] =>
  rows.length === 0 ? [] : ["", style.heading(title), ...rows];

export const renderToolingHelp = (entry: ToolingHelpEntry, options?: CommandHelpOptions): string => {
  const style = helpStyle(options?.styled === true);
  const names = typeableFor(entry.id, [], options?.aliasPolicy, true);
  const input = entry.input;
  const usage =
    input === undefined || (input.acceptsArguments && input.flags.length + input.args.length === 0)
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
          return `  --${flag.name}${flag.boolean ? "[=true|false]" : "=<value>"}${alias}${helpItemMeta(flag)}`;
        });
  const argRows = input === undefined ? [] : input.args.map((arg) => `  ${arg.name}${helpItemMeta(arg)}`);
  const lines = [
    entry.summary,
    "",
    style.heading("USAGE"),
    `  ${style.command(usage)}`,
    ...aliasLines(names.extras, style),
    ...helpSection("FLAGS", flagRows, style),
    ...helpSection("ARGUMENTS", argRows, style),
  ];
  if (entry.runs !== undefined) lines.push("", toolingRunHelp(entry.runs));
  const sharedFlags = sharedFlagHint(input, names.primary);
  if (sharedFlags !== undefined) lines.push("", sharedFlags);
  if (input === undefined || (input.acceptsArguments && input.flags.length + input.args.length === 0))
    lines.push(
      "",
      entry.wrapper
        ? `Arguments and flags after \`${names.primary}\` go to the command. Put Lando's own flags before it, as in \`lando --verbose ${names.primary}\`. Run \`lando help ${names.primary}\` to see this page.`
        : entry.source === "bun-script"
          ? `Run \`lando ${names.primary} -- --help\` to pass --help to the script.`
          : `Run \`lando ${names.primary} -- --help\` to pass --help to the command, or set wrapper: true if the task wraps a CLI tool.`,
    );
  return lines.join("\n");
};
