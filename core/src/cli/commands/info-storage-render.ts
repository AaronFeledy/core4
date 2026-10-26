import type { SummaryField } from "@lando/renderer/summary";
import type { InfoAppService } from "@lando/sdk/app";
import type { ServiceInfoMount } from "@lando/sdk/schema";

import { escapeDiagnosticText } from "../diagnostic-text";

/**
 * Storage presentation for `lando info`: one field per storage lifetime so the
 * label answers "does this data survive?" and the value lists where it mounts.
 * Sources (host paths, volume names) stay in the JSON contract; the default
 * summary shows targets and kinds only. Runtime-reported text is escaped with
 * the shared diagnostic escaper before it reaches either renderer.
 */

type Lifetime = ServiceInfoMount["lifetime"];

const LIFETIME_LABEL: Record<Lifetime, string> = {
  retained: "retained",
  container: "temporary",
  unknown: "unverified",
};

const LIFETIME_ORDER: ReadonlyArray<Lifetime> = ["retained", "container", "unknown"];

const mountKind = (service: InfoAppService, mount: ServiceInfoMount): string => {
  if (
    mount.lifetime === "retained" &&
    service.home?.state === "persisted" &&
    service.home.target === mount.target
  ) {
    return "home";
  }
  switch (mount.type) {
    case "bind":
      return mount.origin === "planned" && service.appMount?.target === mount.target
        ? "app source"
        : "host files";
    case "volume":
      switch (mount.origin) {
        case "planned":
          return "store";
        case "runtime":
          return "runtime volume";
        default: {
          const unreachable: never = mount.origin;
          return unreachable;
        }
      }
    case "tmpfs":
      return "memory";
    case "unknown":
      return "unknown mount";
    default: {
      const unreachable: never = mount.type;
      return unreachable;
    }
  }
};

export const homeFields = (service: InfoAppService): ReadonlyArray<SummaryField> => {
  const home = service.home;
  if (home?.state !== "unknown") return [];
  let reason: string;
  switch (home.reason) {
    case "custom-image":
      reason = "image comes from your Landofile";
      break;
    case "no-identity":
      reason = `${service.type} doesn't declare image users`;
      break;
    case "undeclared-user":
      reason = `${service.type} doesn't know where ${home.user ?? "the planned user"}'s home is`;
      break;
    default: {
      const unreachable: never = home.reason;
      return unreachable;
    }
  }
  return [
    {
      label: "home",
      value: `not kept automatically · ${escapeDiagnosticText(reason)} · set services.${escapeDiagnosticText(service.service)}.home.path to keep one`,
    },
  ];
};

/** Observation wording that never reads as data loss: absence is "not mounted", missing evidence is "unconfirmed". */
const observationNote = (observation: ServiceInfoMount["observation"]): string | undefined => {
  switch (observation) {
    case "present":
      return undefined;
    case "missing":
      return "not mounted";
    case "unknown":
      return "unconfirmed";
    default: {
      const unreachable: never = observation;
      return unreachable;
    }
  }
};

const mountText = (service: InfoAppService, mount: ServiceInfoMount): string => {
  const notes = [
    mountKind(service, mount),
    mount.readOnly === true ? "read-only" : undefined,
    observationNote(mount.observation),
  ];
  return `${escapeDiagnosticText(mount.target)} (${notes.filter((note) => note !== undefined).join(", ")})`;
};

/** Lifetime-grouped summary fields; empty when nothing is known, so quiet services stay quiet. */
export const storageFields = (service: InfoAppService): ReadonlyArray<SummaryField> => {
  const mounts = service.mounts ?? [];
  return LIFETIME_ORDER.flatMap((lifetime) => {
    const group = mounts.filter((mount) => mount.lifetime === lifetime);
    return group.length === 0
      ? []
      : [
          {
            label: LIFETIME_LABEL[lifetime],
            value: group.map((mount) => mountText(service, mount)).join(", "),
          },
        ];
  });
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

const targetList = (mounts: ReadonlyArray<ServiceInfoMount>): string =>
  listFormat.format(mounts.map((mount) => escapeDiagnosticText(mount.target)));

/**
 * One remediation per service, only where a next step applies. A runtime
 * volume at a target the plan never declares needs a `storage:` declaration;
 * one sitting where a declared mount is missing needs the container recreated,
 * which `lando start` does only after a plan change and `lando rebuild` does
 * explicitly. Neither promises a migration: data in the runtime volume is not
 * moved. A volume at a target whose planned mount is merely unconfirmed gets
 * no advice, because the evidence cannot say whether it is the declared store.
 */
export const storageRemedy = (service: InfoAppService): string | undefined => {
  const mounts = service.mounts ?? [];
  const plannedByTarget = new Map(
    mounts.filter((mount) => mount.origin === "planned").map((mount) => [mount.target, mount]),
  );
  const runtimeVolumes = mounts.filter((mount) => mount.origin === "runtime" && mount.type === "volume");
  const undeclared = runtimeVolumes.filter((mount) => !plannedByTarget.has(mount.target));
  const stale = runtimeVolumes.filter(
    (mount) => plannedByTarget.get(mount.target)?.observation === "missing",
  );
  const sentences = [
    ...(undeclared.length === 0
      ? []
      : [
          `To keep ${targetList(undeclared)} across container replacement, declare persistent storage for ${undeclared.length === 1 ? "it" : "them"} under this service's \`storage:\` in your Landofile. Declaring does not move existing data.`,
        ]),
    ...(stale.length === 0
      ? []
      : [
          `\`lando start\` recreates this container with the declared ${stale.length === 1 ? "mount" : "mounts"} at ${targetList(stale)} after a plan change; if ${stale.length === 1 ? "it remains" : "they remain"} not mounted, run \`lando rebuild\`. Data in the current ${stale.length === 1 ? "volume" : "volumes"} there is not moved.`,
        ]),
  ];
  return sentences.length === 0 ? undefined : sentences.join(" ");
};

/** Tab-separated `mount` rows: target, kind, source, lifetime, observation, access. */
export const plainStorageRows = (service: InfoAppService): ReadonlyArray<string> => {
  const rows = (service.mounts ?? []).map((mount) =>
    [
      service.service,
      "mount",
      escapeDiagnosticText(mount.target),
      mountKind(service, mount),
      mount.source === undefined ? "-" : escapeDiagnosticText(mount.source),
      LIFETIME_LABEL[mount.lifetime],
      observationNote(mount.observation) ?? "mounted",
      mount.readOnly === undefined ? "-" : mount.readOnly ? "read-only" : "read-write",
    ].join("\t"),
  );
  const remedy = storageRemedy(service);
  return remedy === undefined ? rows : [...rows, `${service.service}\tmount-note\t${remedy}`];
};
