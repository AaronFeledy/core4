/**
 * The argv protocol of `__internal:repair-root-ownership`: setup builds the exact argv it plans as
 * a host change, and the compiled entry parses it and runs the walker as root, printing one JSON
 * report line. Exit 0 is a finished walk, 2 a refusal before any change, 3 a partial walk. The
 * parser is strict: an unknown or repeated flag, or the same `--root` or `--path` twice, refuses;
 * `--storage` names the first root's provider storage and is left out with the data root.
 */
import * as fs from "node:fs";

import { homeOfUid } from "./account-home.ts";
import {
  type Refusal,
  type RepairHost,
  type RepairRequest,
  parseId,
  refused,
  repairRootOwnership,
  validId,
} from "./root-ownership-repair.ts";

const COMMAND = "__internal:repair-root-ownership";

const systemRepairHost = (): RepairHost => ({
  euid: process.geteuid?.(),
  env: { SUDO_UID: process.env.SUDO_UID, SUDO_GID: process.env.SUDO_GID },
  platform: process.platform,
  now: () => performance.now(),
  // The account database the planner asked too; never a user-controlled HOME or sudo environment.
  homeOf: (uid) => homeOfUid(uid),
  lstatSync: (path) => fs.lstatSync(path, { bigint: true }),
  fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
  statfsSync: fs.statfsSync,
  readdirSync: (path) => fs.readdirSync(path, { encoding: "buffer" }),
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  fchownSync: fs.fchownSync,
});

export const parseRepairArgs = (argv: readonly string[]): RepairRequest | Refusal => {
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      flag !== "--uid" &&
      flag !== "--gid" &&
      flag !== "--root" &&
      flag !== "--storage" &&
      flag !== "--path"
    )
      return refused("unknown-flag");
    if (value === undefined || value.length === 0 || value.startsWith("--")) return refused("missing-value");
    const values = options.get(flag);
    if (values === undefined) options.set(flag, [value]);
    else if ((flag === "--root" || flag === "--path") && !values.includes(value)) values.push(value);
    else return refused("duplicate-flag");
  }
  const uid = parseId(options.get("--uid")?.[0]);
  const gid = parseId(options.get("--gid")?.[0]);
  const roots = options.get("--root");
  const paths = options.get("--path");
  const storage = options.get("--storage")?.[0];
  if (roots === undefined || paths === undefined || !options.has("--uid") || !options.has("--gid"))
    return refused("missing-flag");
  if (!validId(uid) || !validId(gid)) return refused("invalid-id");
  return { uid, gid, roots, ...(storage === undefined ? {} : { storage }), paths };
};

export const repairArgv = (request: RepairRequest & { readonly invocation: readonly string[] }): string[] => [
  ...request.invocation,
  COMMAND,
  "--uid",
  String(request.uid),
  "--gid",
  String(request.gid),
  ...request.roots.flatMap((root) => ["--root", root]),
  ...(request.storage === undefined ? [] : ["--storage", request.storage]),
  ...request.paths.flatMap((path) => ["--path", path]),
];

export const runRepairCli = (
  argv: readonly string[],
  write: (line: string) => void,
  host: RepairHost = systemRepairHost(),
): number => {
  const parsed = parseRepairArgs(argv);
  const report = "refused" in parsed ? parsed : repairRootOwnership(parsed, host);
  write(`${JSON.stringify(report)}\n`);
  if ("refused" in report) return 2;
  return report.incomplete.length > 0 ? 3 : 0;
};
