export const VOLUME_HISTORY_IMAGE = "oven/bun:1.4.0-alpine";
export const VOLUME_HISTORY_MOUNT = "/lando-data";
export const VOLUME_HISTORY_MODE = 0o1777;

// Runs inside the scoped helper, not the host. Directory descriptors prevent
// symlink following; fchmod + fsync make the sticky-writable root durable.
const source = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const C = fs.constants;
const fail = () => { throw new Error("Unsafe history volume root"); };
const input = JSON.parse(process.argv[1]);
const descriptor = (fd) => "/proc/self/fd/" + fd;
try {
  if (typeof input.root !== "string" || !path.isAbsolute(input.root) || path.normalize(input.root) !== input.root ||
      input.root === "/" || /^\/(proc|sys|dev)(\/|$)/.test(input.root)) fail();
  let rootFd = fs.openSync("/", C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const component of input.root.split("/").filter(Boolean)) {
      const next = fs.openSync(descriptor(rootFd) + "/" + component, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(rootFd);
      rootFd = next;
    }
  } catch (error) { fs.closeSync(rootFd); throw error; }
  try {
    fs.fchmodSync(rootFd, ${VOLUME_HISTORY_MODE});
    fs.fsyncSync(rootFd);
  } finally { fs.closeSync(rootFd); }
} catch { process.stderr.write("History volume init unavailable or unsafe\n"); process.exitCode = 1; }
`;

export const volumeHistoryInitCommand = (
  root: string = VOLUME_HISTORY_MOUNT,
): readonly string[] => ["bun", "-e", source, JSON.stringify({ root })];
