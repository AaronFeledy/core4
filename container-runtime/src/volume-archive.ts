import { reservedVolumeEntries } from "./volume-archive-reserved.ts";

/** Mount target every data helper uses for the volume it archives or restores. */
export const VOLUME_ARCHIVE_MOUNT = "/lando-data";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const reservedPatterns = reservedVolumeEntries.map((entry) => (entry.endsWith("-") ? `${entry}*` : entry));

/** `tar` excludes for the reserved root entries. */
const reservedTarExcludes = reservedPatterns
  .map((pattern) => `--exclude=${shellQuote(`./${pattern}`)}`)
  .join(" ");

/**
 * Publication moves the old contents aside (evacuation), records with a reserved
 * marker that installation started, installs the staged contents, applies staging's
 * owner and mode, and removes staging and the marker. Every phase is resumable from
 * on-disk evidence, so a rerun never evacuates entries it already installed.
 */
const publishFunction = `
reserved_name() {
  case "$1" in
    ${reservedPatterns.join("|")}) return 0;;
  esac
  return 1
}

evacuate_entries() {
  dest="$1"
  for entry in ./* ./.[!.]* ./..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=\${entry#./}
    if reserved_name "$name"; then continue; fi
    mv -- "$entry" "$dest/" || return 1
  done
}

install_entries() {
  src="$1"
  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=\${entry##*/}
    if reserved_name "$name"; then continue; fi
    mv -- "$entry" ./ || return 1
  done
}

publish_volume() {
  id="$1"
  stage=".lando-import-$id"
  replaced=".lando-replaced-$id"
  installing=".lando-installing-$id"
  if [ ! -d "$stage" ]; then
    if [ -d "$replaced" ]; then
      rm -f "$installing" || return 1
      return 0
    fi
    printf '%s\\n' "volume publication staging for $id is missing" >&2
    return 1
  fi
  owner=$(stat -c '%u:%g' "$stage") || return 1
  mode=$(stat -c '%a' "$stage") || return 1
  if [ ! -d "$replaced" ]; then
    mkdir "$replaced" || return 1
  fi
  if [ ! -e "$installing" ]; then
    evacuate_entries "$replaced" || return 1
    : > "$installing" || return 1
    sync || return 1
  fi
  install_entries "$stage" || return 1
  chown "$owner" . || return 1
  chmod "$mode" . || return 1
  rm -rf "$stage" || return 1
  rm -f "$installing" || return 1
}`;

/**
 * Finishes or discards leftovers of earlier transactions. Staging without a replaced
 * directory never committed, so it is removed. Both together mean the commit point was
 * crossed and publication is resumed, then the old copy disposed. A replaced directory
 * alone is already published, and an installing marker alone is stale.
 */
const reconcileFunction = `
reconcile_volume() {
  for entry in .lando-import-*; do
    [ -d "$entry" ] || continue
    id=\${entry#.lando-import-}
    if [ -d ".lando-replaced-$id" ]; then
      publish_volume "$id" || return 1
      rm -rf ".lando-replaced-$id" || return 1
    else
      rm -rf "$entry" || return 1
    fi
  done
  for entry in .lando-replaced-*; do
    [ -d "$entry" ] || continue
    id=\${entry#.lando-replaced-}
    if [ -d ".lando-import-$id" ]; then continue; fi
    rm -rf "$entry" || return 1
  done
  for entry in .lando-installing-*; do
    [ -e "$entry" ] || continue
    id=\${entry#.lando-installing-}
    if [ -d ".lando-import-$id" ] || [ -d ".lando-replaced-$id" ]; then continue; fi
    rm -f "$entry" || return 1
  done
}`;

const scaffolding = `${publishFunction}\n${reconcileFunction}`;

/** Reconcile leftovers in the current volume root. Requires the volume mounted read-write. */
export const volumeArchiveReconcileScript = (): string => `set -e\n${scaffolding}\nreconcile_volume`;

/** Create the import staging directory with the root's current owner, then mode. */
const createStagingScript = (id: string): string => `
stage=".lando-import-${id}"
mkdir "$stage" || return 1
chown "$(stat -c '%u:%g' .)" "$stage" || return 1
chmod "$(stat -c '%a' .)" "$stage" || return 1`;

/** Reconcile leftovers, create staging, and stream the archive from stdin into it. */
export const volumeArchiveExtractCommand = (id: string): readonly string[] => [
  "sh",
  "-c",
  `set -e
# lando-volume-helper:extract
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)}
${scaffolding}
reconcile_volume
${createStagingScript(id)}
exec tar -xpf - --numeric-owner -C "$stage"`,
];

/** Publication body for a prepared staging directory; callers run it with cwd at the volume root. */
export const volumeArchivePublishScript = (id: string): string =>
  `set -e
${publishFunction}
publish_volume ${shellQuote(id)}`;

/** One uninterruptible publication run for a prepared staging directory. */
export const volumeArchivePublishCommand = (id: string): readonly string[] => [
  "sh",
  "-c",
  `# lando-volume-helper:publish
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)}
${volumeArchivePublishScript(id)}`,
];

/** Remove the replaced copy after a successful publication. Interruptible. */
export const volumeArchiveDisposeCommand = (id: string): readonly string[] => [
  "sh",
  "-c",
  `# lando-volume-helper:dispose
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)} && rm -rf ${shellQuote(`.lando-replaced-${id}`)}`,
];

/**
 * Remove only a staging directory that belongs to this transaction. Refuse once the
 * commit point was crossed: an incomplete publication stays recoverable. Used as a
 * best-effort finalizer; reconciliation removes strangers' leftovers later.
 */
export const volumeArchiveDiscardStagingCommand = (id: string): readonly string[] => [
  "sh",
  "-c",
  `# lando-volume-helper:discard
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)} || exit 1
if [ -d ${shellQuote(`.lando-replaced-${id}`)} ] || [ -e ${shellQuote(`.lando-installing-${id}`)} ]; then exit 0; fi
rm -rf ${shellQuote(`.lando-import-${id}`)}`,
];

/** Reconcile, then stream the volume as an uncompressed tar excluding reserved entries. */
export const volumeArchiveExportCommand = (): readonly string[] => [
  "sh",
  "-c",
  `set -e
# lando-volume-helper:export
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)}
${scaffolding}
reconcile_volume
exec tar -cf - --numeric-owner ${reservedTarExcludes} .`,
];

/**
 * Reconcile, then capture the volume into the container's own `/snapshot` directory
 * with a tar pipe so hardlinks across entries and the root's owner and mode survive.
 * Busybox tar skips sockets on both capture and extraction.
 */
export const volumeSnapshotCaptureCommand = (): readonly string[] => [
  "sh",
  "-c",
  `set -e
set -o pipefail
# lando-volume-helper:snapshot-capture
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)}
${scaffolding}
reconcile_volume
rm -rf /snapshot
mkdir -p /snapshot
tar -cf - --numeric-owner ${reservedTarExcludes} . | tar -xpf - --numeric-owner -C /snapshot`,
];

/** Reconcile the target, stage the snapshot image's `/snapshot` inside the volume. */
export const volumeSnapshotExtractCommand = (id: string): readonly string[] => [
  "sh",
  "-c",
  `set -e
set -o pipefail
# lando-volume-helper:snapshot-extract
cd ${shellQuote(VOLUME_ARCHIVE_MOUNT)}
${scaffolding}
reconcile_volume
${createStagingScript(id)}
tar -cf - -C /snapshot --numeric-owner . | tar -xpf - --numeric-owner -C "$stage"`,
];

/** What one helper argv does, shared with provider fakes and tests. */
export type VolumeArchiveHelperCall =
  | { readonly kind: "export" | "snapshot-capture" | "unknown" }
  | {
      readonly kind: "extract" | "snapshot-extract" | "publish" | "dispose" | "discard";
      readonly id: string;
    };

/** Classify a volume-archive helper argv without retyping any script text at call sites. */
export const classifyVolumeArchiveCommand = (command: ReadonlyArray<string>): VolumeArchiveHelperCall => {
  const script = command[0] === "sh" && command[1] === "-c" ? command[2] : undefined;
  if (script === undefined) return { kind: "unknown" };
  const kind = script.match(/# lando-volume-helper:([a-z-]+)/u)?.[1];
  if (kind === "export" || kind === "snapshot-capture") return { kind };
  if (
    kind !== "extract" &&
    kind !== "snapshot-extract" &&
    kind !== "publish" &&
    kind !== "dispose" &&
    kind !== "discard"
  ) {
    return { kind: "unknown" };
  }
  const id =
    script.match(/\.lando-(?:import|replaced|installing)-([0-9a-f-]{36})/u)?.[1] ??
    script.match(/publish_volume '([0-9a-f-]{36})'/u)?.[1];
  return id === undefined ? { kind: "unknown" } : { kind, id };
};
