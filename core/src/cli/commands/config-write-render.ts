export const renderConfigWriteResult = (input: {
  readonly file: string;
  readonly subcommand?: string | undefined;
  readonly key?: string | undefined;
  readonly changed?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly editSavedLabel: string;
}): string | undefined => {
  const { file, key } = input;
  switch (input.subcommand) {
    case "set":
      return input.dryRun === true ? `${file}: would set ${key} (dry run).` : `${file}: set ${key}.`;
    case "unset":
      if (input.changed !== true) return `${file}: ${key} was not present (no change).`;
      return input.dryRun === true ? `${file}: would unset ${key} (dry run).` : `${file}: unset ${key}.`;
    case "edit":
      return `${file}: saved edited ${input.editSavedLabel}.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return undefined;
  }
};
