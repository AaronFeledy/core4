/**
 * Preserves provider-specific error details across synchronous value conversion.
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

const scalarText = (value: string | number | boolean | null): string => (value === null ? "" : String(value));

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
    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    if ((typeof value === "string" && !INTEGER_TEXT.test(value)) || !Number.isSafeInteger(parsed)) {
      return fail(`Compose runtime knob \`ulimits.${name}\` requires an integer ${label} limit.`, {
        knob: "ulimits",
        limit: name,
        bound: label,
        value,
      });
    }
    return parsed;
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

interface ResourcesKnob {
  readonly limits?:
    | {
        readonly cpus?: number | string | undefined;
        readonly memory?: number | undefined;
        readonly pids?: number | string | undefined;
      }
    | undefined;
  readonly reservations?: { readonly memory?: number | undefined } | undefined;
}

const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/u;
const RESOURCES_KNOB = "deploy.resources";

// Compose applies a memory value only when it is set to more than zero; zero means no limit.
const memoryBytes = (field: string, value: number | undefined, fail: InvalidKnob): number | undefined => {
  if (value === undefined || value === 0) return undefined;
  return safeInteger(value) !== undefined && value > 0
    ? value
    : fail(`Compose runtime knob \`${RESOURCES_KNOB}.${field}\` requires a non-negative byte size.`, {
        knob: RESOURCES_KNOB,
        field,
        value,
      });
};

const nanoCpus = (value: number | string | undefined, fail: InvalidKnob): number | undefined => {
  if (value === undefined) return undefined;
  const cpus = typeof value === "number" ? value : DECIMAL_TEXT.test(value) ? Number(value) : Number.NaN;
  const details = { knob: RESOURCES_KNOB, field: "limits.cpus", value };
  if (!Number.isFinite(cpus) || cpus < 0) {
    return fail(
      `Compose runtime knob \`${RESOURCES_KNOB}.limits.cpus\` requires a non-negative number.`,
      details,
    );
  }
  // The engine takes whole nanoCPUs; a value past the safe-integer range serializes as null.
  const nano = Math.round(cpus * 1e9);
  if (safeInteger(nano) === undefined) {
    return fail(
      `Compose runtime knob \`${RESOURCES_KNOB}.limits.cpus\` exceeds the largest CPU limit a container engine accepts (${Math.floor(Number.MAX_SAFE_INTEGER / 1e9)}).`,
      details,
    );
  }
  return nano === 0 ? undefined : nano;
};

// Compose sets a process limit only when it is above zero; 0 and -1 both mean no limit.
const pidsLimit = (value: number | string | undefined, fail: InvalidKnob): number | undefined => {
  if (value === undefined) return undefined;
  const pids =
    typeof value === "number" ? value : INTEGER_TEXT.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (safeInteger(pids) === undefined) {
    return fail(`Compose runtime knob \`${RESOURCES_KNOB}.limits.pids\` requires an integer.`, {
      knob: RESOURCES_KNOB,
      field: "limits.pids",
      value,
    });
  }
  return pids > 0 ? pids : undefined;
};

export const resourceControls = (
  resources: ResourcesKnob | undefined,
  fail: InvalidKnob,
): Record<string, number> | undefined => {
  if (resources === undefined) return undefined;
  const controls = Object.entries({
    Memory: memoryBytes("limits.memory", resources.limits?.memory, fail),
    NanoCpus: nanoCpus(resources.limits?.cpus, fail),
    PidsLimit: pidsLimit(resources.limits?.pids, fail),
    MemoryReservation: memoryBytes("reservations.memory", resources.reservations?.memory, fail),
  }).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return controls.length === 0 ? undefined : Object.fromEntries(controls);
};

class ResourceControlIssue {
  constructor(
    readonly message: string,
    readonly field: string | undefined,
  ) {}
}

/** The first resource value no engine dialect can realize, so planning rejects it before provider action. */
export const resourceControlIssue = (
  resources: ResourcesKnob | undefined,
): { readonly message: string; readonly field: string | undefined } | undefined => {
  try {
    resourceControls(resources, (message, details) => {
      throw new ResourceControlIssue(message, typeof details.field === "string" ? details.field : undefined);
    });
    return undefined;
  } catch (issue) {
    if (issue instanceof ResourceControlIssue) return issue;
    throw issue;
  }
};

interface DeviceRequestKnob {
  readonly capabilities?: ReadonlyArray<string> | undefined;
  readonly count?: number | string | undefined;
  readonly device_ids?: ReadonlyArray<string> | undefined;
  readonly driver?: string | undefined;
  readonly options?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

// Compose reads a request with neither count nor device_ids as every device, and "all" as -1.
const deviceCount = (knob: string, request: DeviceRequestKnob, fail: InvalidKnob): number => {
  const { count } = request;
  if (count === undefined) return request.device_ids === undefined ? -1 : 0;
  if (typeof count === "number") return count;
  if (count.toLowerCase() === "all") return -1;
  const parsed = INTEGER_TEXT.test(count) ? Number.parseInt(count, 10) : Number.NaN;
  return (
    safeInteger(parsed) ??
    fail(`Compose runtime knob \`${knob}\` requires a count of "all" or an integer.`, {
      knob,
      value: count,
    })
  );
};

const deviceRequest = (knob: string, request: DeviceRequestKnob, fail: InvalidKnob) => {
  const options = scalarTextMap(request.options);
  return {
    ...(request.driver === undefined ? {} : { Driver: request.driver }),
    Count: deviceCount(knob, request, fail),
    ...(request.device_ids === undefined ? {} : { DeviceIDs: request.device_ids }),
    Capabilities: [request.capabilities ?? []],
    ...(options === undefined ? {} : { Options: options }),
  };
};

export type DeviceRequest = ReturnType<typeof deviceRequest>;

/** Compose adds the `gpu` capability to every `gpus` request; `all` is one request for every GPU. */
export const gpuDeviceRequests = (
  gpus: "all" | ReadonlyArray<DeviceRequestKnob> | undefined,
  fail: InvalidKnob,
): ReadonlyArray<DeviceRequest> | undefined =>
  (gpus === "all" ? [{ count: "all" }] : gpus)?.map((request) =>
    deviceRequest("gpus", { ...request, capabilities: [...(request.capabilities ?? []), "gpu"] }, fail),
  );

export const reservedDeviceRequests = (
  devices: ReadonlyArray<DeviceRequestKnob> | undefined,
  fail: InvalidKnob,
): ReadonlyArray<DeviceRequest> | undefined =>
  devices?.map((request) => deviceRequest(`${RESOURCES_KNOB}.reservations.devices`, request, fail));
