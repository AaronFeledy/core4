import type { ServicePlan } from "@lando/sdk/schema";

/**
 * Reads a generated Apache launcher as argv and returns the directives it
 * carries, failing on any `-c` flag that lost its directive. Asserting on
 * directives instead of one serialized string keeps a test a behavioral proof
 * rather than a snapshot of the command's spelling.
 */
export const apacheLauncherDirectives = (
  command: ServicePlan["command"],
  launcherName: string,
): ReadonlyArray<string> => {
  if (!Array.isArray(command)) throw new Error(`Apache command must be argv, got ${typeof command}.`);
  const [launcher, ...rest] = command as ReadonlyArray<string>;
  if (launcher !== launcherName) {
    throw new Error(`Apache launcher must be ${launcherName}, got ${String(launcher)}.`);
  }
  const directives: Array<string> = [];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const directive = rest[index + 1];
    if (flag !== "-c") throw new Error(`Expected a -c flag at argv position ${index}, got ${String(flag)}.`);
    if (directive === undefined) throw new Error(`The -c flag at argv position ${index} has no directive.`);
    directives.push(directive);
  }
  return directives;
};
