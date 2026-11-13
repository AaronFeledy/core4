import {
  type CommandSpec,
  type ScheduleJob,
  isMappableEveryDurationMs,
  parseEveryDurationMs,
} from "@lando/sdk/schema";

import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_BIN, SUPERCRONIC_CRONTAB } from "./supercronic.ts";

export const posixQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

export const commandToShell = (run: CommandSpec): string =>
  typeof run === "string" ? run : run.map(posixQuote).join(" ");

/**
 * Map a Landofile `every:` value onto a crontab schedule the pinned supercronic
 * binary accepts. `@every` is not valid supercronic syntax; whole seconds
 * become a 7-field expression, whole minutes and hours stay 5-field.
 */
export const everyToSupercronicSchedule = (every: string): string | undefined => {
  const trimmed = every.trim();
  const ms = parseEveryDurationMs(trimmed);
  if (ms === undefined) return trimmed;
  if (!isMappableEveryDurationMs(ms)) return undefined;
  const seconds = ms / 1000;
  if (seconds < 60) return seconds === 1 ? "* * * * * * *" : `*/${seconds} * * * * * *`;
  const minutes = seconds / 60;
  if (minutes < 60) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
  const hours = minutes / 60;
  return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
};

export const crontabLine = (job: Pick<ScheduleJob, "every" | "run">): string => {
  const schedule = everyToSupercronicSchedule(job.every);
  return `${schedule ?? job.every} ${commandToShell(job.run)}`;
};

/**
 * Shell script that installs the pinned supercronic binary for the image
 * architecture. Kept separate from the crontab step so editing a `schedule:`
 * entry does not invalidate the downloaded binary layer.
 */
export const supercronicInstallCommand = (): string => {
  const amd64 = SUPERCRONIC_ARTIFACTS.amd64;
  const arm64 = SUPERCRONIC_ARTIFACTS.arm64;
  return `set -eu
arch=$(uname -m)
case "$arch" in
  x86_64) url=${posixQuote(amd64.url)}; sha=${posixQuote(amd64.sha256)} ;;
  aarch64|arm64) url=${posixQuote(arm64.url)}; sha=${posixQuote(arm64.sha256)} ;;
  *) echo "Unsupported architecture $arch for scheduled jobs." >&2; exit 1 ;;
esac
tmp=/tmp/supercronic
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && curl -fsSL "$url" -o "$tmp"
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl && curl -fsSL "$url" -o "$tmp"
else
  echo "Cannot install the scheduler: this image has no curl, wget, apt-get, or apk." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
else
  echo "Cannot verify the scheduler: this image has no sha256sum or shasum." >&2
  exit 1
fi
if [ "$actual" != "$sha" ]; then
  echo "Scheduler checksum mismatch." >&2
  exit 1
fi
mkdir -p ${SUPERCRONIC_BIN.slice(0, SUPERCRONIC_BIN.lastIndexOf("/"))}
cp "$tmp" ${SUPERCRONIC_BIN}
chmod 0755 ${SUPERCRONIC_BIN}
rm -f "$tmp"`;
};

/**
 * Shell script that writes the sidecar crontab. The file is world-readable so a
 * sidecar running as any job user can read the schedules it was started with.
 */
export const crontabInstallCommand = (crontab: ReadonlyArray<string>): string => {
  const directory = SUPERCRONIC_CRONTAB.slice(0, SUPERCRONIC_CRONTAB.lastIndexOf("/"));
  const writeLines = crontab
    .map((line) => `printf '%s\\n' ${posixQuote(line)} >> ${SUPERCRONIC_CRONTAB}`)
    .join("\n");
  return `set -eu
mkdir -p ${directory}
: > ${SUPERCRONIC_CRONTAB}
${writeLines}
chmod 0644 ${SUPERCRONIC_CRONTAB}`;
};
