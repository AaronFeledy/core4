import { resolve } from "node:path";
import { TOMCAT_MAJORS, type TomcatMajor, sha256 } from "../../../../scripts/tomcat-config.ts";
import type { TomcatFetch } from "../../../../scripts/tomcat-registry.ts";
import { readTomcatSnapshot } from "../../../../scripts/update-tomcat.ts";

export type RegistryFailure = "digest" | "platform" | "version" | "shape" | "network" | "exact" | "blob";
export const tomcatRegistryFixture = async (failure?: RegistryFailure) => {
  const original = await readTomcatSnapshot(
    resolve(import.meta.dirname, "../../../../plugins/service-lando/tomcat"),
  );
  const replies = new Map<string, { readonly body: string; readonly digest?: string }>();
  const pins = { ...original.pins.majors };
  const registry = "https://registry-1.docker.io/v2/library/tomcat/";
  const add = (path: string, body: string) => {
    const digest = `sha256:${sha256(body)}`;
    replies.set(`${registry}${path}`, { body, digest });
    return digest;
  };
  replies.set(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/tomcat:pull",
    { body: JSON.stringify({ token: "public-test-token" }) },
  );
  for (const major of TOMCAT_MAJORS) {
    const pin = pins[major];
    const manifests = [];
    for (const architecture of ["amd64", "arm64"] as const) {
      const version = failure === "version" && architecture === "arm64" ? "99.0.1" : pin.version;
      const config = JSON.stringify({
        os: "linux",
        architecture,
        config: {
          Env: [
            `TOMCAT_VERSION=${version}`,
            `TOMCAT_SHA512=${"a".repeat(128)}`,
            "CATALINA_HOME=/usr/local/tomcat",
          ],
        },
      });
      const configDigest = `sha256:${sha256(config)}`;
      add(`blobs/${configDigest}`, failure === "blob" ? `${config} ` : config);
      const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
      const digest = `sha256:${sha256(manifest)}`;
      add(`manifests/${digest}`, manifest);
      if (!(failure === "platform" && architecture === "arm64"))
        manifests.push({ digest, platform: { os: "linux", architecture } });
    }
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests,
    });
    const digest = add(`manifests/${major}-jre21`, body);
    add(`manifests/${pin.version}-jre21`, failure === "exact" ? `${body} ` : body);
    pins[major] = { ...pin, indexDigest: digest };
    replies.set(`https://api.github.com/repos/apache/tomcat/git/ref/tags/${pin.version}`, {
      body: JSON.stringify({ object: { sha: pin.upstreamCommit, type: "commit" } }),
    });
    replies.set(`https://raw.githubusercontent.com/apache/tomcat/${pin.upstreamCommit}/conf/server.xml`, {
      body: failure === "shape" ? "<Server/>" : original.configs[major],
    });
  }
  const request: TomcatFetch = async (url) => {
    if (failure === "network") return new Response("unavailable", { status: 503 });
    const reply = replies.get(url);
    if (reply === undefined) throw new TypeError(`Unexpected fixture URL: ${url}`);
    return new Response(reply.body, {
      headers:
        reply.digest === undefined
          ? {}
          : { "docker-content-digest": failure === "digest" ? `sha256:${"0".repeat(64)}` : reply.digest },
    });
  };
  return {
    snapshot: { pins: { schemaVersion: 1 as const, majors: pins }, configs: original.configs },
    request,
    replies,
  };
};

export const rebuildFixtureImage = (
  fixture: Awaited<ReturnType<typeof tomcatRegistryFixture>>,
  major: TomcatMajor,
): void => {
  for (const tag of [`${major}-jre21`, `${fixture.snapshot.pins.majors[major].version}-jre21`]) {
    const url = `https://registry-1.docker.io/v2/library/tomcat/manifests/${tag}`;
    const current = fixture.replies.get(url);
    if (current === undefined) throw new TypeError("Missing fixture index");
    const body = `${current.body}\n`;
    fixture.replies.set(url, { body, digest: `sha256:${sha256(body)}` });
  }
};
