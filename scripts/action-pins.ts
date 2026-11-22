import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ACTION_PINS_PATH = ".github/actions/pins.yml";

const PIN_LINE =
  /^ {2}- uses: (?<action>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(?<sha>[0-9a-f]{40}) # (?<release>v\d+\.\d+\.\d+)$/;

export type ActionPin = {
  readonly action: string;
  /** `owner/repo@<sha>`: the value a parsed workflow step holds. */
  readonly ref: string;
  /** `owner/repo@<sha> # vX.Y.Z`: the text a generator writes after `uses:`. */
  readonly uses: string;
};

export const parseActionPins = (source: string): ReadonlyMap<string, ActionPin> => {
  const pins = new Map<string, ActionPin>();
  for (const [index, line] of source.split("\n").entries()) {
    if (line === "" || line === "pins:" || line.startsWith("#")) continue;
    const groups = PIN_LINE.exec(line)?.groups;
    const where = `${ACTION_PINS_PATH}:${index + 1}`;
    if (groups?.action === undefined || groups.sha === undefined || groups.release === undefined) {
      throw new Error(
        `${where}: expected "  - uses: owner/repo@<40-hex commit> # vX.Y.Z", got ${JSON.stringify(line)}`,
      );
    }
    if (pins.has(groups.action)) throw new Error(`${where}: ${groups.action} is pinned twice`);
    const ref = `${groups.action}@${groups.sha}`;
    pins.set(groups.action, { action: groups.action, ref, uses: `${ref} # ${groups.release}` });
  }
  return pins;
};

export const ACTION_PINS = parseActionPins(
  readFileSync(resolve(import.meta.dirname, "..", ACTION_PINS_PATH), "utf8"),
);

const pinFor = (action: string): ActionPin => {
  const pin = ACTION_PINS.get(action);
  if (pin === undefined) throw new Error(`${action} has no pin in ${ACTION_PINS_PATH}; add one there first`);
  return pin;
};

/** The `uses:` value for `action`, such as `actions/checkout@<sha> # v7.0.1`. */
export const pinnedAction = (action: string): string => pinFor(action).uses;

/** The `owner/repo@<sha>` ref a YAML parser reads back from a pinned `uses:` value. */
export const pinnedActionRef = (action: string): string => pinFor(action).ref;
