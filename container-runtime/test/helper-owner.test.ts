import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { ephemeralDataHelperLabels } from "../src/ephemeral-data-helpers.ts";
import {
  type HelperOwnerIdentity,
  type OwnerProcessObservation,
  helperOwnerIdentity,
  isActiveHelper,
  parseProcessStartToken,
  probeHelperOwnerPid,
  readProcessStartToken,
  registerActiveHelper,
  releaseActiveHelper,
} from "../src/helper-owner.ts";
import { DATA_HELPER_ROLE, PROVIDER_LABEL, ROLE_LABEL } from "../src/labels.ts";
import { type DataHelperReclaimInput, dataHelperReclaimVerdict } from "../src/stale-data-helpers.ts";

const NOW = 1_700_000_000_000;
const STALE = new Date(NOW - 600_001).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

const SELF: HelperOwnerIdentity = {
  machine: "a".repeat(32),
  pidDomain: "pid:[4026531836]",
  pid: 100,
  boot: "boot-1",
  start: "500",
};

const labelsFor = (owner: HelperOwnerIdentity, remove = true): Readonly<Record<string, string>> =>
  ephemeralDataHelperLabels({ providerId: "test", owner, remove });

const legacyLabels = { [ROLE_LABEL]: DATA_HELPER_ROLE, [PROVIDER_LABEL]: "test" };

const baseInput = (): DataHelperReclaimInput => ({
  labels: labelsFor(SELF),
  providerId: "test",
  name: "helper",
  state: "running",
  running: true,
  nowMs: NOW,
  identity: SELF,
  isActive: () => false,
  probe: (): OwnerProcessObservation => ({ state: "unknown" }),
});

const withLabels = (
  labels: Readonly<Record<string, string>>,
  extra: Partial<DataHelperReclaimInput> = {},
) => ({ ...baseInput(), ...extra, labels });

const otherOwner = (overrides: Partial<HelperOwnerIdentity>): HelperOwnerIdentity => ({
  ...SELF,
  pid: 200,
  start: "700",
  ...overrides,
});

test.each([
  {
    name: "a service container is not a data helper",
    input: withLabels({ ...labelsFor(SELF), [ROLE_LABEL]: "service" }),
    expected: "keep",
  },
  {
    name: "a helper of another provider",
    input: withLabels({ ...labelsFor(SELF), [PROVIDER_LABEL]: "other" }),
    expected: "keep",
  },
  {
    name: "a retained helper",
    input: withLabels(labelsFor(SELF, false)),
    expected: "keep",
  },
  {
    name: "a retained helper even when the owner's boot differs",
    input: withLabels(labelsFor(otherOwner({ boot: "boot-2" }), false)),
    expected: "keep",
  },
  {
    name: "an unknown lifecycle value",
    input: withLabels({ ...labelsFor(SELF), "dev.lando.helper-lifecycle": "paused" }),
    expected: "keep",
  },
  {
    name: "missing machine metadata",
    input: withLabels({ ...labelsFor(SELF), "dev.lando.helper-owner-machine": "" }),
    expected: "keep",
  },
  {
    name: "missing pid-domain metadata",
    input: withLabels({ ...labelsFor(SELF), "dev.lando.helper-owner-pid-domain": "" }),
    expected: "keep",
  },
  {
    name: "a non-numeric owner pid",
    input: withLabels({ ...labelsFor(SELF), "dev.lando.helper-owner-pid": "not-a-pid" }),
    expected: "keep",
  },
  {
    name: "an unknown self identity",
    input: { ...baseInput(), identity: undefined },
    expected: "keep",
  },
  {
    name: "an owner on another machine",
    input: withLabels(labelsFor(otherOwner({ machine: "b".repeat(32) }))),
    expected: "keep",
  },
  {
    name: "an owner from another boot",
    input: withLabels(labelsFor(otherOwner({ boot: "boot-2" }))),
    expected: "remove",
  },
  {
    name: "an owner in another pid domain",
    input: withLabels(labelsFor(otherOwner({ pidDomain: "pid:[1]" }))),
    expected: "keep",
  },
  {
    name: "this process's own helper with no active claim",
    input: withLabels(labelsFor(SELF)),
    expected: "remove",
  },
  {
    name: "this process's own active helper",
    input: withLabels(labelsFor(SELF), { isActive: (name: string): boolean => name === "helper" }),
    expected: "keep",
  },
  {
    name: "this pid before a start-token change",
    input: withLabels(labelsFor({ ...SELF, start: "499" })),
    expected: "remove",
  },
  {
    name: "a live owner process with the expected start token",
    input: withLabels(labelsFor(otherOwner({})), {
      probe: () => ({ state: "present", start: "700" }),
    }),
    expected: "keep",
  },
  {
    name: "a live owner process with a different start token",
    input: withLabels(labelsFor(otherOwner({})), {
      probe: () => ({ state: "present", start: "701" }),
    }),
    expected: "remove",
  },
  {
    name: "a live owner process without a start token",
    input: withLabels(labelsFor(otherOwner({})), {
      probe: () => ({ state: "present" }),
    }),
    expected: "keep",
  },
  {
    name: "an absent owner process",
    input: withLabels(labelsFor(otherOwner({})), {
      probe: () => ({ state: "absent" }),
    }),
    expected: "remove",
  },
  {
    name: "an unverifiable owner process",
    input: withLabels(labelsFor(otherOwner({})), {
      probe: () => ({ state: "unknown" }),
    }),
    expected: "keep",
  },
  {
    name: "an unlabeled helper that has been stopped long enough",
    input: withLabels(legacyLabels, {
      state: "exited",
      running: false,
      finishedAt: STALE,
      created: STALE,
    }),
    expected: "remove",
  },
  {
    name: "an unlabeled helper that is still running",
    input: withLabels(legacyLabels, {
      state: "running",
      running: true,
      finishedAt: STALE,
    }),
    expected: "keep",
  },
  {
    name: "an unlabeled helper stopped recently",
    input: withLabels(legacyLabels, {
      state: "exited",
      running: false,
      finishedAt: FRESH,
      created: FRESH,
    }),
    expected: "keep",
  },
  {
    name: "an unlabeled helper that never started long ago",
    input: withLabels(legacyLabels, {
      state: "created",
      running: false,
      created: STALE,
    }),
    expected: "remove",
  },
  {
    name: "an unlabeled helper that never started recently",
    input: withLabels(legacyLabels, {
      state: "created",
      running: false,
      created: FRESH,
    }),
    expected: "keep",
  },
] as const)("$name is kept or removed as declared", ({ input, expected }) => {
  expect(dataHelperReclaimVerdict(input)).toBe(expected);
});

test("recovery of this process's helper name reflects the active registry", () => {
  registerActiveHelper("active-helper");
  try {
    expect(
      dataHelperReclaimVerdict({
        ...baseInput(),
        name: "active-helper",
        labels: labelsFor(SELF),
        isActive: isActiveHelper,
      }),
    ).toBe("keep");
  } finally {
    releaseActiveHelper("active-helper");
  }
  expect(
    dataHelperReclaimVerdict({
      ...baseInput(),
      name: "active-helper",
      labels: labelsFor(SELF),
      isActive: isActiveHelper,
    }),
  ).toBe("remove");
});

test("parses starttime after a command name containing spaces and parentheses", () => {
  const fields = Array.from({ length: 19 }, (_, index) => String(index + 3));
  const stat = `123 (my helper) (x)) ${fields.join(" ")} 4242 0 0 0`;
  expect(parseProcessStartToken(stat)).toBe("4242");
});

test.each([
  ["no command terminator", "123 1 2 3"],
  ["too few fields", "123 (comm) 1 2 3"],
  ["a non-numeric starttime", `123 (comm) ${Array(19).fill("0").join(" ")} nope`],
] as const)("rejects a stat record with %s", (_name, stat) => {
  expect(parseProcessStartToken(stat)).toBeUndefined();
});

test.skipIf(process.platform !== "linux")(
  "observes a real process as present and then absent",
  async () => {
    const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore" });
    try {
      const before = probeHelperOwnerPid(child.pid);
      expect(before.state).toBe("present");
      expect(before.start).toMatch(/^\d+$/u);
      expect(before.start).toBe(readProcessStartToken(child.pid));
    } finally {
      child.kill();
      await child.exited;
    }
    expect(probeHelperOwnerPid(child.pid)).toEqual({ state: "absent" });
  },
  10_000,
);

// Hosts without a machine id (some minimal containers) record no owner; that path is covered by the verdict table.
const hasMachineId = ["/etc/machine-id", "/var/lib/dbus/machine-id"].some(
  (path) => existsSync(path) && readFileSync(path, "utf8").trim().length > 0,
);

test.skipIf(process.platform !== "linux" || !hasMachineId)(
  "captures a Linux owner identity from the live process",
  async () => {
    const identity = await Effect.runPromise(helperOwnerIdentity);
    expect(identity?.machine).toMatch(/^[0-9a-f]{32}$/u);
    expect(identity?.pid).toBe(process.pid);
    expect(identity?.pidDomain).toMatch(/^pid:\[\d+\]$/u);
    expect(identity?.start).toMatch(/^\d+$/u);
    expect(identity?.start).toBe(readProcessStartToken(process.pid));
  },
);
