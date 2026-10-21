import { Flags } from "../spec/metadata";

export const formatFlag = Flags.string({ description: "Output format.", default: "table" });
export const typeFlag = Flags.string({
  description: "Value type for set; inferred from the config schema when omitted.",
  options: ["string", "number", "boolean", "json", "yaml"],
});
export const pathFlag = Flags.string({ description: "Dot-path key selector." });
export const editorFlag = Flags.string({ description: "Editor binary for edit." });
export const dryRunFlag = Flags.boolean({
  description: "Report the change without writing.",
  default: false,
});
