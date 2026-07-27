// =============================================================================
// Podman Compose runtime-knob value coercion.
//
// Turns canonical (post-decode) Compose knob values into the scalar shapes the
// Podman docker-compatible `POST /containers/create` body expects. Every helper
// is total or loud: a value that cannot be coerced raises through `InvalidKnob`
// naming the offending knob, never silently defaults or drops.
// =============================================================================

/**
 * Caller-supplied failure channel. Never returns — `bring-up` wraps the
 * realizer in `Effect.try` and converts the throw into a tagged provider error.
 */
export type InvalidKnob = (message: string, details: Record<string, unknown>) => never;

interface DeviceKnob {
  readonly source: string;
  readonly target?: string | undefined;
  readonly permissions?: string | undefined;
}

interface UlimitKnob {
  readonly soft: number | string;
  readonly hard: number | string;
}

interface LoggingKnob {
  readonly driver?: string | undefined;
  readonly options?: Readonly<Record<string, string | number | null>> | undefined;
}

// YAML 1.1 truthiness, which is how Compose spells booleans that survive as
// strings through a Landofile round trip.
const TRUTHY_SPELLINGS = new Set(["true", "1", "yes", "on"]);
const FALSY_SPELLINGS = new Set(["false", "0", "no", "off"]);
const INTEGER_TEXT = /^[+-]?\d+$/u;

const safeInteger = (value: number): number | undefined => (Number.isSafeInteger(value) ? value : undefined);

export const knobBoolean = (
  knob: string,
  value: boolean | string | undefined,
  fail: InvalidKnob,
): boolean | undefined => {
  if (value === undefined || typeof value === "boolean") return value;

  const spelling = value.toLowerCase();
  if (TRUTHY_SPELLINGS.has(spelling)) return true;
  if (FALSY_SPELLINGS.has(spelling)) return false;

  return fail(`Compose runtime knob \`${knob}\` is not a boolean.`, { knob, value });
};

export const scalarText = (value: string | number | boolean | null): string =>
  value === null ? "" : String(value);

export const scalarTextMap = (
  values: Readonly<Record<string, string | number | boolean | null>> | undefined,
): Record<string, string> | undefined =>
  values === undefined
    ? undefined
    : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, scalarText(value)]));

export const groupEntries = (groups: ReadonlyArray<string | number> | undefined) =>
  groups?.map((group) => scalarText(group));

export const deviceMappings = (devices: ReadonlyArray<DeviceKnob> | undefined) =>
  devices?.map((device) => ({
    PathOnHost: device.source,
    PathInContainer: device.target ?? device.source,
    CgroupPermissions: device.permissions ?? "rwm",
  }));

const ulimitEntry = (name: string, limit: UlimitKnob, fail: InvalidKnob) => {
  const bound = (label: "soft" | "hard", value: number | string): number => {
    const invalid = () =>
      fail(`Compose runtime knob \`ulimits.${name}\` requires an integer ${label} limit.`, {
        knob: "ulimits",
        limit: name,
        bound: label,
        value,
      });

    const parsed =
      typeof value === "number" ? value : INTEGER_TEXT.test(value) ? Number.parseInt(value, 10) : Number.NaN;
    return safeInteger(parsed) ?? invalid();
  };

  return { Name: name, Soft: bound("soft", limit.soft), Hard: bound("hard", limit.hard) };
};

export const ulimitEntries = (
  ulimits: Readonly<Record<string, UlimitKnob>> | undefined,
  fail: InvalidKnob,
) =>
  ulimits === undefined
    ? undefined
    : Object.entries(ulimits).map(([name, limit]) => ulimitEntry(name, limit, fail));

// Compose tmpfs entries are "<target>" or "<target>:<options>"; Podman wants a
// target-to-options map, so the split is on the FIRST colon only.
export const tmpfsMounts = (
  mounts: ReadonlyArray<string> | undefined,
  fail: InvalidKnob,
): Record<string, string> | undefined => {
  if (mounts === undefined) return undefined;

  const map: Record<string, string> = {};
  for (const mount of mounts) {
    const separator = mount.indexOf(":");
    const target = separator === -1 ? mount : mount.slice(0, separator);
    if (Object.hasOwn(map, target)) {
      return fail("Compose runtime knob `tmpfs` repeats a container destination.", {
        knob: "tmpfs",
        target,
      });
    }
    map[target] = separator === -1 ? "" : mount.slice(separator + 1);
  }
  return map;
};

export const positiveInteger = (
  knob: string,
  value: number | undefined,
  fail: InvalidKnob,
): number | undefined => {
  if (value === undefined) return undefined;
  return safeInteger(value) !== undefined && value > 0
    ? value
    : fail(`Compose runtime knob \`${knob}\` requires a positive integer.`, { knob, value });
};

export const nonNegativeInteger = (
  knob: string,
  value: number | undefined,
  fail: InvalidKnob,
): number | undefined => {
  if (value === undefined) return undefined;
  return safeInteger(value) !== undefined && value >= 0
    ? value
    : fail(`Compose runtime knob \`${knob}\` requires a non-negative integer.`, { knob, value });
};

// One "host:address" entry per address — a hostname mapped to several addresses
// fans out instead of collapsing into a single comma-joined entry.
export const extraHostEntries = (
  hosts: Readonly<Record<string, string | ReadonlyArray<string>>> | undefined,
): ReadonlyArray<string> | undefined => {
  if (hosts === undefined) return undefined;

  const entries: string[] = [];
  for (const [host, addresses] of Object.entries(hosts)) {
    for (const address of typeof addresses === "string" ? [addresses] : addresses) {
      entries.push(`${host}:${address}`);
    }
  }
  return entries;
};

// Podman refuses these drivers over a remote connection, which is the only way
// the bundled providers ever talk to it. Every other driver name is an operand
// Podman validates itself, so this is a rejection list, not an allowlist.
const REMOTE_INVALID_LOG_DRIVERS = new Set(["passthrough", "passthrough-tty"]);

export const logConfig = (logging: LoggingKnob | undefined, fail: InvalidKnob) => {
  if (logging === undefined) return undefined;

  if (logging.driver !== undefined && REMOTE_INVALID_LOG_DRIVERS.has(logging.driver)) {
    return fail(
      `Compose logging driver \`${logging.driver}\` cannot be used through Lando's remote Podman API. Choose a remote-compatible driver such as \`k8s-file\`, \`json-file\`, \`journald\`, or \`none\`, or remove \`logging.driver\`.`,
      { knob: "logging", driver: logging.driver },
    );
  }

  const options = scalarTextMap(logging.options);
  return {
    ...(logging.driver === undefined ? {} : { Type: logging.driver }),
    ...(options === undefined ? {} : { Config: options }),
  };
};
