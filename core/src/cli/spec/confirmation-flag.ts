import { Flags } from "./metadata";

export const yesFlag = (description?: string) =>
  Flags.boolean({ char: "y", ...(description === undefined ? {} : { description }), default: false });

export const nonPromptingYesFlag = yesFlag(
  "Accepted so scripts can confirm every destructive command the same way. This command does not prompt.",
);
