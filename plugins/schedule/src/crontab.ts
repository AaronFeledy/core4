import type { CommandSpec, ScheduleJob } from "@lando/sdk/schema";

import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_BIN, SUPERCRONIC_CRONTAB } from "./supercronic.ts";

export const posixQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

export const commandToShell = (run: CommandSpec): string =>
  typeof run === "string" ? run : run.map(posixQuote).join(" ");

const NUMERIC_USER = /^(\d+)(?::(\d+))?$/u;

/** Drop to a named or numeric container user. Sidecars run as root so this works under a non-root parent. */
export const dropPrivilegesCommand = (user: string, command: string): string => {
  const quoted = posixQuote(command);
  const match = NUMERIC_USER.exec(user);
  if (match !== null) {
    const uid = match[1];
    const gid = match[2];
    const regid = gid === undefined ? "" : ` --regid=${gid}`;
    return `setpriv --reuid=${uid}${regid} --clear-groups -- sh -c ${quoted}`;
  }
  const quotedUser = posixQuote(user);
  return `setpriv --reuid=${quotedUser} --regid=${quotedUser} --init-groups -- sh -c ${quoted}`;
};

export const crontabCommand = (job: ScheduleJob, parentUser: string | undefined): string => {
  const command = commandToShell(job.run);
  const user = job.user ?? parentUser;
  if (user === undefined) return command;
  return dropPrivilegesCommand(user, command);
};

export const crontabLine = (job: ScheduleJob, parentUser: string | undefined): string =>
  `${job.every} ${crontabCommand(job, parentUser)}`;

export const supercronicInstallCommand = (crontab: ReadonlyArray<string>): string => {
  const amd64 = SUPERCRONIC_ARTIFACTS.amd64;
  const arm64 = SUPERCRONIC_ARTIFACTS.arm64;
  const writeCrontab = crontab
    .map((line) => `printf '%s\\n' ${posixQuote(line)} >> ${SUPERCRONIC_CRONTAB}`)
    .join("\n");
  return `set -eux
arch=$(uname -m)
case "$arch" in
  x86_64) url=${posixQuote(amd64.url)}; sha=${posixQuote(amd64.sha256)} ;;
  aarch64|arm64) url=${posixQuote(arm64.url)}; sha=${posixQuote(arm64.sha256)} ;;
  *) echo "Unsupported architecture $arch for scheduled jobs." >&2; exit 1 ;;
esac
if command -v setpriv >/dev/null 2>&1; then
  :
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update && apt-get install -y --no-install-recommends util-linux
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache setpriv
else
  echo "Cannot install setpriv to run scheduled jobs as a numeric or named user." >&2
  exit 1
fi
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
install -m 0755 "$tmp" ${SUPERCRONIC_BIN}
rm -f "$tmp"
mkdir -p ${SUPERCRONIC_CRONTAB.slice(0, SUPERCRONIC_CRONTAB.lastIndexOf("/"))}
: > ${SUPERCRONIC_CRONTAB}
${writeCrontab}`;
};
