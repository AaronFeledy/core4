import { Flags } from "../spec/metadata";

export const typeFlag = Flags.string({
  description: "Value type for set; inferred from the config schema when omitted.",
  options: ["string", "number", "boolean", "json", "yaml"],
});
export const pathFlag = Flags.string({
  description: 'Key selector with dots, [0] for indices, and ["key.with.dots"] for literal keys.',
});
export const editorFlag = Flags.string({ description: "Editor binary for edit." });
export const dryRunFlag = Flags.boolean({
  description: "Report the change without writing.",
  default: false,
});
