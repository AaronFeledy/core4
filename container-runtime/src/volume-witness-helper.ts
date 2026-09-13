export const VOLUME_WITNESS_FILE = ".lando-volume-witness.json";
export const VOLUME_WITNESS_IMAGE = "oven/bun:1.4.0-alpine";

// Runs inside the scoped helper, not the host. Directory/file descriptors prevent
// symlink following; fsync precedes publication and acknowledgement. link is the
// no-clobber election: losing adopters read the winner, never replace its bytes.
const source = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const C = fs.constants;
const input = JSON.parse(process.argv[1]);
const fail = () => { throw new Error("Unsafe or foreign volume witness"); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const valid = (record) => record !== null && typeof record === "object" &&
  record.version === 1 && typeof record.ownerRoot === "string" &&
  (record.ownerRoot.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(record.ownerRoot) || /^\\\\[^\\]+\\[^\\]+/.test(record.ownerRoot)) &&
  typeof record.generation === "string" && uuid.test(record.generation) && Object.keys(record).length === 3;
const descriptor = (fd) => "/proc/self/fd/" + fd;
try {
  if (typeof input.root !== "string" || !path.isAbsolute(input.root) || path.normalize(input.root) !== input.root ||
      input.root === "/" || /^\/(proc|sys|dev)(\/|$)/.test(input.root) ||
      !["read", "adopt"].includes(input.operation)) fail();
  let rootFd = fs.openSync("/", C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const component of input.root.split("/").filter(Boolean)) {
      const next = fs.openSync(descriptor(rootFd) + "/" + component, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(rootFd);
      rootFd = next;
    }
  } catch (error) { fs.closeSync(rootFd); throw error; }
  try {
    const root = descriptor(rootFd);
    const witnessPath = root + "/.lando-volume-witness.json";
    const read = () => {
      let fd;
      try { fd = fs.openSync(witnessPath, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 4095) !== 384 || stat.uid !== process.getuid() ||
            stat.gid !== process.getgid() || stat.size < 1 || stat.size > 8192) fail();
        const record = JSON.parse(fs.readFileSync(fd, "utf8"));
        const current = fs.lstatSync(witnessPath);
        if (current.ino !== stat.ino || current.dev !== stat.dev || !valid(record)) fail();
        if (input.ownerRoot !== undefined && record.ownerRoot !== input.ownerRoot) fail();
        fs.fsyncSync(fd);
        return record;
      } finally { fs.closeSync(fd); }
    };
    let record = read();
    if (record === null && input.operation === "adopt") {
      const candidate = { version: 1, generation: input.generation, ownerRoot: input.ownerRoot };
      if (!valid(candidate) || Buffer.byteLength(JSON.stringify(candidate), "utf8") > 8192) fail();
      process.umask(63);
      const stage = fs.mkdtempSync(root + "/.lando-witness-stage-");
      const stageFd = fs.openSync(stage, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      const staged = descriptor(stageFd) + "/record";
      try {
        const fd = fs.openSync(staged, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 384);
        try {
          fs.fchownSync(fd, process.getuid(), process.getgid());
          fs.fchmodSync(fd, 384);
          fs.writeFileSync(fd, JSON.stringify(candidate));
          fs.fsyncSync(fd);
        }
        finally { fs.closeSync(fd); }
        try { fs.linkSync(staged, witnessPath); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally {
        fs.unlinkSync(staged);
        fs.closeSync(stageFd);
        fs.rmdirSync(stage);
      }
      fs.fsyncSync(rootFd);
      record = read();
      if (record === null) fail();
    }
    if (record !== null) {
      fs.fsyncSync(rootFd);
      const reread = read();
      if (reread === null || reread.generation !== record.generation || reread.ownerRoot !== record.ownerRoot) fail();
      record = reread;
    }
    process.stdout.write(JSON.stringify(record) + "\n");
  } finally { fs.closeSync(rootFd); }
} catch { process.stderr.write("Volume witness unavailable or unsafe\n"); process.exitCode = 1; }
`;

export interface VolumeWitnessCommandInput {
  readonly operation: "read" | "adopt";
  readonly root: string;
  readonly ownerRoot?: string;
  readonly generation?: string;
}

export const volumeWitnessCommand = (input: VolumeWitnessCommandInput): readonly string[] => [
  "bun",
  "-e",
  source,
  JSON.stringify(input),
];
