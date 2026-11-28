import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

/** Register with `afterEach` in each test file that creates config dirs. */
export const removeDockerConfigs = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lando-docker-config-"));
  roots.push(dir);
  return dir;
};

export interface DockerConfigDir {
  readonly dir: string;
  readonly current: (name: string) => DockerConfigDir;
  readonly context: (
    name: string,
    docker: Record<string, unknown>,
    tlsFiles?: readonly string[],
  ) => DockerConfigDir;
  readonly rawContext: (name: string, metaJson: string) => DockerConfigDir;
}

/** A Docker CLI config dir laid out the way `docker context create` and `docker context use` write it. */
export const dockerConfig = (dir = tempDir()): DockerConfigDir => {
  mkdirSync(dir, { recursive: true });
  // The CLI stores each context under the hex SHA-256 of its name.
  const contextDir = (store: "meta" | "tls", name: string) =>
    join(dir, "contexts", store, createHash("sha256").update(name).digest("hex"));
  const writeMeta = (name: string, bytes: string) => {
    mkdirSync(contextDir("meta", name), { recursive: true });
    writeFileSync(join(contextDir("meta", name), "meta.json"), bytes);
  };
  const api: DockerConfigDir = {
    dir,
    current: (name) => {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ auths: {}, currentContext: name }));
      return api;
    },
    context: (name, docker, tlsFiles = []) => {
      writeMeta(name, JSON.stringify({ Name: name, Metadata: { Description: "" }, Endpoints: { docker } }));
      if (tlsFiles.length > 0) mkdirSync(join(contextDir("tls", name), "docker"), { recursive: true });
      for (const file of tlsFiles) writeFileSync(join(contextDir("tls", name), "docker", file), "pem");
      return api;
    },
    rawContext: (name, metaJson) => {
      writeMeta(name, metaJson);
      return api;
    },
  };
  return api;
};
