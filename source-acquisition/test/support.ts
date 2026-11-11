import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { sha256Hex } from "@lando/sdk/digest";
import type { NpmPackageDist, NpmPackument } from "../src/npm.ts";
import type { ArchiveTransport, GitTransport, NpmRegistryTransport } from "../src/types.ts";

const writeAscii = (target: Uint8Array, offset: number, value: string): void => {
  target.set(new TextEncoder().encode(value), offset);
};

export const makeTar = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array; readonly typeflag?: number }>,
): Uint8Array => {
  const blockSize = 512;
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(blockSize);
    header.set(new TextEncoder().encode(member.name).subarray(0, 100), 0);
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    writeAscii(header, 124, `${member.bytes.length.toString(8).padStart(11, "0")} `);
    writeAscii(header, 136, "00000000000 ");
    header[156] = member.typeflag ?? 0x30;
    writeAscii(header, 257, "ustar\0");
    header[263] = 0x30;
    header[264] = 0x30;
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header);
    const padded = new Uint8Array(Math.ceil(member.bytes.length / blockSize) * blockSize);
    padded.set(member.bytes);
    chunks.push(padded);
  }
  chunks.push(new Uint8Array(blockSize * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const makeTarGz = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array; readonly typeflag?: number }>,
): Uint8Array => new Uint8Array(gzipSync(Buffer.from(makeTar(members))));

export const packageTarball = (files: Readonly<Record<string, string>>): Uint8Array =>
  makeTarGz(
    Object.entries(files).map(([name, content]) => ({
      name: name.startsWith("package/") ? name : `package/${name}`,
      bytes: new TextEncoder().encode(content),
    })),
  );

export const sha256Of = (bytes: Uint8Array): string => sha256Hex(bytes);

export const sriSha512 = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export const sriSha256 = (bytes: Uint8Array): string =>
  `sha256-${createHash("sha256").update(bytes).digest("base64")}`;

export const shasumOf = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

export interface FakeNpmRegistry {
  readonly transport: NpmRegistryTransport;
  readonly calls: {
    readonly packument: string[];
    readonly tarball: Array<{ packageName: string; tarball: string }>;
  };
  setPackument: (name: string, packument: NpmPackument | undefined) => void;
  setTarball: (tarballUrl: string, bytes: Uint8Array) => void;
  setRegistry: (registry: string) => void;
}

export const makeFakeNpmRegistry = (input?: { readonly registry?: string }): FakeNpmRegistry => {
  let registry = input?.registry ?? "https://registry.npmjs.org/";
  const packuments = new Map<string, NpmPackument | undefined>();
  const tarballs = new Map<string, Uint8Array>();
  const calls: FakeNpmRegistry["calls"] = {
    packument: [],
    tarball: [],
  };
  return {
    calls,
    setPackument: (name, packument) => void packuments.set(name, packument),
    setTarball: (url, bytes) => void tarballs.set(url, bytes),
    setRegistry: (next) => {
      registry = next;
    },
    transport: {
      registryFor: (name) => {
        void name;
        return registry;
      },
      packument: async (name) => {
        calls.packument.push(name);
        return packuments.get(name);
      },
      tarball: async ({ packageName, dist }) => {
        calls.tarball.push({ packageName, tarball: dist.tarball });
        const bytes = tarballs.get(dist.tarball);
        if (bytes === undefined) throw new Error(`missing tarball fixture for ${dist.tarball}`);
        return bytes;
      },
    },
  };
};

export const npmVersion = (input: {
  readonly name: string;
  readonly version: string;
  readonly dist: NpmPackageDist;
}): NpmPackument => ({
  "dist-tags": { latest: input.version },
  versions: {
    [input.version]: {
      name: input.name,
      version: input.version,
      dist: input.dist,
    },
  },
});

export interface FakeArchiveTransport {
  readonly transport: ArchiveTransport;
  readonly calls: string[];
  set: (url: string, bytes: Uint8Array) => void;
  fail: (url: string, error: unknown) => void;
}

export const makeFakeArchiveTransport = (): FakeArchiveTransport => {
  const files = new Map<string, Uint8Array>();
  const failures = new Map<string, unknown>();
  const calls: string[] = [];
  return {
    calls,
    set: (url, bytes) => void files.set(url, bytes),
    fail: (url, error) => void failures.set(url, error),
    transport: {
      fetch: async (url) => {
        calls.push(url);
        if (failures.has(url)) throw failures.get(url);
        const bytes = files.get(url);
        if (bytes === undefined) throw new Error(`missing archive fixture for ${url}`);
        return bytes;
      },
    },
  };
};

export interface FakeGitTransport {
  readonly transport: GitTransport;
  readonly calls: Array<{ url: string; ref?: string; dest: string }>;
  /** When set, next fetch throws this error (auth/fetch-failed). */
  nextError?: unknown;
  /** Map ref -> commit + files to materialize under dest. */
  setRef: (ref: string, commit: string, files: Readonly<Record<string, string>>) => void;
  defaultCommit?: string;
}

export const makeFakeGitTransport = (): FakeGitTransport => {
  const refs = new Map<string, { commit: string; files: Readonly<Record<string, string>> }>();
  const calls: Array<{ url: string; ref?: string; dest: string }> = [];
  const fake: FakeGitTransport = {
    calls,
    setRef: (ref, commit, files) => void refs.set(ref, { commit, files }),
    transport: {
      fetch: async ({ url, ref, dest }) => {
        calls.push({ url, dest, ...(ref === undefined ? {} : { ref }) });
        if (fake.nextError !== undefined) {
          const err = fake.nextError;
          fake.nextError = undefined;
          throw err;
        }
        const key = ref ?? "HEAD";
        const hit = refs.get(key) ?? (fake.defaultCommit === undefined ? undefined : refs.get("HEAD"));
        if (hit === undefined) throw new Error(`no git fixture for ref ${key}`);
        for (const [rel, content] of Object.entries(hit.files)) {
          const target = join(dest, rel);
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, content);
        }
        // Simulate leftover .git that production must strip.
        await mkdir(join(dest, ".git"), { recursive: true });
        await writeFile(join(dest, ".git", "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(dest, "link-target.txt"), "target\n");
        return { commit: hit.commit };
      },
    },
  };
  return fake;
};

/** Create a real bare git repo with one commit; returns { bare, commit, work }. */
export const makeBareGitRepo = async (
  files: Readonly<Record<string, string>> = { "readme.txt": "hi\n" },
): Promise<{
  readonly bare: string;
  readonly commit: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-git-bare-"));
  const work = join(root, "work");
  const bare = join(root, "bare.git");
  await mkdir(work, { recursive: true });
  const run = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    return stdout.trim();
  };
  await run(work, ["init", "-q", "-b", "main"]);
  await run(work, ["config", "user.email", "test@example.com"]);
  await run(work, ["config", "user.name", "test"]);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(work, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(join(work, "sym-target"), "payload\n");
  await symlink("sym-target", join(work, "sym-link"));
  await run(work, ["add", "."]);
  await run(work, ["commit", "-q", "-m", "init"]);
  const commit = await run(work, ["rev-parse", "HEAD"]);
  await run(root, ["clone", "--bare", "-q", work, bare]);
  return {
    bare,
    commit,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};
