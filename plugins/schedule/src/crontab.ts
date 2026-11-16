import { type CommandSpec, isMappableEveryDurationMs, parseEveryDurationMs } from "@lando/sdk/schema";

import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_BIN } from "./supercronic.ts";

export const posixQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

export const commandToShell = (run: CommandSpec): string =>
  typeof run === "string" ? run : run.map(posixQuote).join(" ");

const EVERY_PREFIX = /^@every\s+/u;

/**
 * Map a Landofile `every:` value onto a crontab schedule the pinned supercronic
 * binary accepts. `@every` is not valid supercronic syntax; whole seconds
 * become a 7-field expression, whole minutes and hours stay 5-field.
 */
export const everyToSupercronicSchedule = (every: string): string | undefined => {
  const trimmed = every.trim();
  const ms = parseEveryDurationMs(trimmed);
  // A malformed @every is not a schedule the scheduler understands either.
  if (ms === undefined) return EVERY_PREFIX.test(trimmed) ? undefined : trimmed;
  if (!isMappableEveryDurationMs(ms)) return undefined;
  const seconds = ms / 1000;
  if (seconds < 60) return seconds === 1 ? "* * * * * * *" : `*/${seconds} * * * * * *`;
  const minutes = seconds / 60;
  if (minutes < 60) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
  const hours = minutes / 60;
  if (hours === 24) return "0 0 * * *";
  return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
};

export interface CrontabJob {
  readonly name: string;
  readonly every: string;
  readonly run: CommandSpec;
}

export interface CrontabPaths {
  readonly crontab: string;
  readonly jobsDirectory: string;
  readonly scheduler: string;
}

export const jobScriptPath = (jobsDirectory: string, name: string): string => `${jobsDirectory}/${name}`;

/**
 * A string command is the authored script verbatim, so a multi-line block
 * scalar keeps its lines. An argv command becomes `exec <quoted argv>`, which
 * keeps argument boundaries and embedded newlines intact under `sh`.
 */
export const jobScriptContent = (run: CommandSpec): string =>
  typeof run === "string" ? `${run}\n` : `exec ${commandToShell(run)}\n`;

/**
 * A crontab is line-based, so a job's command never appears on it: the line
 * names the job's script, and the script holds the command.
 */
export const crontabLine = (job: Pick<CrontabJob, "every" | "name">, jobsDirectory: string): string => {
  const schedule = everyToSupercronicSchedule(job.every);
  return `${schedule ?? job.every} sh ${jobScriptPath(jobsDirectory, job.name)}`;
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
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates
  curl -fsSL "$url" -o "$tmp"
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl
  curl -fsSL "$url" -o "$tmp"
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

export interface CrontabTimezone {
  readonly service: string;
  readonly zone: string;
}

const ZONE_NAME = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/u;

/**
 * A value that names no zone at all cannot be honored, and it must never reach
 * a `/usr/share/zoneinfo` path or the crontab, so the step becomes the refusal.
 */
const timezoneRefusal = ({ service, zone }: CrontabTimezone): string | undefined => {
  if (ZONE_NAME.test(zone)) return undefined;
  const message = `Scheduled jobs for service ${service} use TZ=${zone}, which is not a timezone name. Scheduled jobs need a zone name such as America/Chicago or UTC.`;
  return `echo ${posixQuote(message)} >&2\nexit 1`;
};

/**
 * Shell script that makes the zone loadable, because the crontab pins
 * `CRON_TZ` and the scheduler spawns jobs in it. An image with no timezone
 * database gets one from its package manager. An image that has a database but
 * not this zone is not reinstalled: the name is wrong. A zone that still cannot
 * be loaded fails this step, so a failed install is never cached as a layer.
 * UTC needs no data, and a value that names no zone is refused by the crontab
 * step instead.
 */
export const timezoneDataInstallCommand = ({ service, zone }: CrontabTimezone): string | undefined => {
  if (zone === "UTC" || !ZONE_NAME.test(zone)) return undefined;
  const failedInstall = `Scheduled jobs for service ${service} use TZ=${zone}, but Lando could not install the image's timezone database. Fix the package error above, or install the timezone database in the service's build.artifact.`;
  const unknownZone = `Scheduled jobs for service ${service} use TZ=${zone}, but the image cannot load that timezone. Check the zone name. If the name is right, install the image's timezone database in the service's build.artifact.`;
  return `set -eu
zone_file=${posixQuote(`/usr/share/zoneinfo/${zone}`)}
installed=yes
if [ ! -e "$zone_file" ] && [ ! -e /usr/share/zoneinfo/Etc/UTC ]; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache tzdata || installed=no
  elif command -v apt-get >/dev/null 2>&1; then
    { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata; } || installed=no
  fi
fi
if [ "$installed" = no ]; then
  echo ${posixQuote(failedInstall)} >&2
  exit 1
fi
if [ ! -e "$zone_file" ]; then
  echo ${posixQuote(unknownZone)} >&2
  exit 1
fi`;
};

/**
 * Shell script that writes one script per job, then the crontab that names
 * them. The files are world-readable so a sidecar running as any job user can
 * read the schedules it was started with. The crontab's first line always pins
 * the zone, and the step validates its own output with the scheduler binary so
 * a schedule the scheduler would reject fails the build instead of the sidecar.
 */
export const crontabInstallCommand = (
  jobs: ReadonlyArray<CrontabJob>,
  paths: CrontabPaths,
  timezone: CrontabTimezone,
): string => {
  const refusal = timezoneRefusal(timezone);
  if (refusal !== undefined) return ["set -eu", refusal].join("\n");
  const crontabDirectory = paths.crontab.slice(0, paths.crontab.lastIndexOf("/"));
  const writes = jobs.flatMap((job) => {
    const script = posixQuote(jobScriptPath(paths.jobsDirectory, job.name));
    return [`printf '%s' ${posixQuote(jobScriptContent(job.run))} > ${script}`, `chmod 0644 ${script}`];
  });
  const rows = jobs.map(
    (job) => `printf '%s\\n' ${posixQuote(crontabLine(job, paths.jobsDirectory))} >> ${paths.crontab}`,
  );
  return [
    "set -eu",
    `mkdir -p ${crontabDirectory} ${paths.jobsDirectory}`,
    `: > ${paths.crontab}`,
    `printf '%s\\n' ${posixQuote(`CRON_TZ=${timezone.zone}`)} >> ${paths.crontab}`,
    ...writes,
    ...rows,
    `chmod 0644 ${paths.crontab}`,
    `if scheduler_output=$(${posixQuote(paths.scheduler)} -test ${posixQuote(paths.crontab)} 2>&1); then`,
    "  :",
    "else",
    "  printf '%s\\n' \"$scheduler_output\" >&2",
    "  exit 1",
    "fi",
  ].join("\n");
};
