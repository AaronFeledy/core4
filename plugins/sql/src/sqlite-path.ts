import { sha256Hex } from "@lando/sdk/digest";

export const SQLITE_HELPER_SCRATCH_TARGET = "/lando-sqlite-scratch";

export const posixJoin = (base: string, relative: string): string => {
  const root = base === "/" ? "" : base.endsWith("/") ? base.slice(0, -1) : base;
  return `${root}/${relative}`;
};

export const posixCovers = (target: string, filePath: string): boolean => {
  const normalized = target === "/" ? "/" : target.endsWith("/") ? target.slice(0, -1) : target;
  return normalized === "/"
    ? filePath.startsWith("/")
    : filePath === normalized || filePath.startsWith(`${normalized}/`);
};

export const sqliteSnapshotStore = (path: string): string => `sqlite-${sha256Hex(path).slice(0, 32)}`;

export const sqliteSidecarPaths = (path: string): ReadonlyArray<string> => [
  `${path}-wal`,
  `${path}-shm`,
  `${path}-journal`,
];
