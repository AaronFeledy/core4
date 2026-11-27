/**
 * The managed provider's Linux prerequisites as host changes: each names its exact commands at
 * plan time and, at apply, re-checks the host before running anything. A change the host already
 * has is reported satisfied; a host that moved away from the plan (a subordinate range now taken)
 * is stale and runs nothing.
 */
import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import type { HostChangeApplier, HostChangeProposal } from "@lando/sdk/services";
import { Effect } from "effect";

import {
  HOST_CHANGE_OWNER,
  SETUP_RERUN,
  changeFailed,
  changeStale,
  privilegedStep,
  runCheckedStep,
} from "./host-change-steps.ts";
import { type RootlessProbes, parseSubordinateIdFile } from "./rootless-preflight.ts";

export const PREREQUISITE_CHANGES = {
  uidmap: HostChangeId.make("provider-lando:install-uidmap"),
  subuids: HostChangeId.make("provider-lando:add-subuids"),
  subgids: HostChangeId.make("provider-lando:add-subgids"),
  delegation: HostChangeId.make("provider-lando:delegate-cgroups"),
  linger: HostChangeId.make("provider-lando:enable-linger"),
} as const;

/** Lingering comes last: it starts the user manager, which then reads the delegation drop-in. */
export const PREREQUISITE_APPLY_ORDER = [
  PREREQUISITE_CHANGES.uidmap,
  PREREQUISITE_CHANGES.subuids,
  PREREQUISITE_CHANGES.subgids,
  PREREQUISITE_CHANGES.delegation,
  PREREQUISITE_CHANGES.linger,
] as const;

export const manualUidmapRemediation =
  "Install newuidmap and newgidmap using the host's trusted package manager (`sudo apt-get install uidmap` or `sudo dnf install shadow-utils`), then rerun `lando setup`.";

export const uidmapChange = (
  host: { readonly id: string; readonly versionId: string },
  probes: RootlessProbes,
): HostChangeProposal => {
  const change: HostChange = {
    id: PREREQUISITE_CHANGES.uidmap,
    owner: HOST_CHANGE_OWNER,
    stage: "provider",
    summary: "Install the uidmap package",
    reason: "Rootless Podman needs newuidmap and newgidmap before the managed runtime can start.",
    consent: "standard",
    persistent: false,
    requirement: "required",
    details: { distribution: host.id, version: host.versionId },
    steps: [
      privilegedStep("update", "Refresh apt package metadata", ["/usr/bin/apt-get", "update"]),
      privilegedStep("install", "Install uidmap", [
        "/usr/bin/apt-get",
        "install",
        "--yes",
        "--no-install-recommends",
        "uidmap",
      ]),
    ],
    undo: {
      _tag: "manual",
      detail:
        "uidmap is a shared system package. Remove it with `sudo apt-get remove uidmap` only if nothing else needs it.",
    },
  };
  const remediation = `Resolve the apt-get failure, ${SETUP_RERUN}; or install uidmap yourself.`;
  return {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      if (probes.probe().hasUidmapTools) return { changed: false };
      yield* runCheckedStep(
        steps,
        change,
        { id: "update" },
        {
          message: "Failed to refresh apt-get package metadata.",
          remediation,
        },
      );
      yield* runCheckedStep(
        steps,
        change,
        { id: "install" },
        { message: "Failed to install uidmap.", remediation },
      );
      if (!probes.probe().hasUidmapTools) {
        return yield* Effect.fail(
          changeFailed(change, {
            message: "uidmap installation completed, but newuidmap/newgidmap remain unavailable.",
            remediation: `Verify /usr/bin/newuidmap and /usr/bin/newgidmap are executable, ${SETUP_RERUN}.`,
          }),
        );
      }
      return { changed: true };
    }),
  };
};

export interface SubordinateRange {
  readonly kind: "uid" | "gid";
  readonly user: string;
  readonly start: number;
  readonly count: number;
}

/** First free start at or after `requested`, above every range the file already holds. */
export const nextSubordinateStart = (text: string | undefined, requested: number): number =>
  (text === undefined ? [] : parseSubordinateIdFile(text)).reduce(
    (start, entry) => Math.max(start, entry.start + entry.count),
    requested,
  );

export const subordinateRangeChange = (
  range: SubordinateRange,
  readHostFile: (path: string) => string | undefined,
): HostChangeProposal => {
  const file = range.kind === "uid" ? "/etc/subuid" : "/etc/subgid";
  const flag = range.kind === "uid" ? "subuids" : "subgids";
  const span = `${range.start}-${range.start + range.count - 1}`;
  const noun = range.kind === "uid" ? "user" : "group";
  const change: HostChange = {
    id: range.kind === "uid" ? PREREQUISITE_CHANGES.subuids : PREREQUISITE_CHANGES.subgids,
    owner: HOST_CHANGE_OWNER,
    stage: "provider",
    summary: `Add subordinate ${noun} IDs ${span} for ${range.user}`,
    reason: `Rootless Podman needs a subordinate ${range.kind.toUpperCase()} range for your user in ${file}.`,
    consent: "standard",
    persistent: false,
    requirement: "required",
    details: { file, range: span, user: range.user },
    steps: [
      privilegedStep("add", `Add ${span} to ${file}`, [
        "/usr/sbin/usermod",
        `--add-${flag}`,
        span,
        range.user,
      ]),
    ],
    undo: {
      _tag: "steps",
      consent: "separate",
      summary: `Remove subordinate ${noun} IDs ${span} for ${range.user}`,
      steps: [
        privilegedStep("remove", `Remove ${span} from ${file}`, [
          "/usr/sbin/usermod",
          `--del-${flag}`,
          span,
          range.user,
        ]),
      ],
    },
  };
  const end = range.start + range.count;
  return {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      const entries = parseSubordinateIdFile(readHostFile(file) ?? "");
      if (entries.some((entry) => entry.user === range.user)) return { changed: false };
      if (entries.some((entry) => entry.start < end && range.start < entry.start + entry.count)) {
        return yield* Effect.fail(
          changeStale(
            change,
            `${file} gained a range that overlaps ${span}`,
            `${file} changed after setup planned ${span}, so Lando added nothing.`,
          ),
        );
      }
      yield* runCheckedStep(
        steps,
        change,
        { id: "add" },
        {
          message: `Failed to add a subordinate ${range.kind.toUpperCase()} range.`,
          remediation: `Add a range for your user to ${file} yourself, for example \`sudo usermod --add-${flag} ${span} ${range.user}\`, ${SETUP_RERUN}.`,
        },
      );
      return { changed: true, facts: { range: span } };
    }),
  };
};

/** Apply the approved prerequisites this provider planned, in dependency order. */
export const applyPrerequisiteHostChanges = (hostChanges: HostChangeApplier | undefined) =>
  hostChanges === undefined
    ? Effect.void
    : Effect.forEach(
        PREREQUISITE_APPLY_ORDER,
        (id) => (hostChanges.approved(id) === undefined ? Effect.void : hostChanges.apply(id)),
        { discard: true },
      );
