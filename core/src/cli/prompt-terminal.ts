/** sudo prompts on the controlling terminal, so it needs real terminals on stdin and stderr. */
export const hostHasPromptTerminal = (): boolean =>
  process.stdin.isTTY === true && process.stderr.isTTY === true;
