import { Schema } from "effect";
import { type TomcatMajor, TomcatUpdateError, sha256 } from "./tomcat-config.ts";

export type TomcatFetch = (url: string, init?: RequestInit) => Promise<Response>;
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)));
const Descriptor = Schema.Struct({
  digest: Digest,
  platform: Schema.optionalKey(Schema.Struct({ os: Schema.String, architecture: Schema.String })),
});
const Index = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  mediaType: Schema.Literals([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ]),
  manifests: Schema.Array(Descriptor),
});
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  config: Schema.Struct({ digest: Digest }),
});
const Config = Schema.Struct({
  os: Schema.Literal("linux"),
  architecture: Schema.String,
  config: Schema.Struct({ Env: Schema.Array(Schema.String) }),
});
const Token = Schema.Struct({ token: Schema.NonEmptyString });
const Reference = Schema.Struct({
  object: Schema.Struct({
    sha: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
    type: Schema.Literals(["commit", "tag"]),
  }),
});
const Tag = Schema.Struct({ tag: Schema.String, object: Reference.fields.object });
const accept =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const assertNever = (value: never): never => {
  throw new TomcatUpdateError(`Unexpected Apache reference type: ${String(value)}`);
};

export const tomcatFetch: TomcatFetch = (url, init) =>
  fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });

export const readTomcatResponse = async (response: Response, label: string): Promise<string> => {
  if (!response.ok) throw new TomcatUpdateError(`${label}: HTTP ${response.status}`);
  return response.text();
};

export const resolveTomcatImage = async (major: TomcatMajor, request: TomcatFetch) => {
  const tokenResponse = await request(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/tomcat:pull",
  );
  const { token } = Schema.decodeUnknownSync(Token)(
    JSON.parse(await readTomcatResponse(tokenResponse, "Docker public authentication")),
  );
  const registry = async (path: string, expected?: string) => {
    let response = await request(`https://registry-1.docker.io/v2/library/tomcat/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
    });
    if (response.status === 307 && path.startsWith("blobs/")) {
      const location = response.headers.get("location");
      const target = location === null ? undefined : new URL(location);
      if (
        target === undefined ||
        target.protocol !== "https:" ||
        target.hostname !== "production.cloudfront.docker.com" ||
        target.port !== "" ||
        target.username !== "" ||
        target.password !== ""
      ) {
        throw new TomcatUpdateError(`Tomcat ${major}: untrusted registry blob redirect`);
      }
      // Docker's signed storage URL authorizes itself; the registry pull token must never leave its origin.
      response = await request(target.href);
    }
    const body = await readTomcatResponse(response, `Tomcat ${major} registry object`);
    const digest = `sha256:${sha256(body)}`;
    const header = response.headers.get("docker-content-digest");
    if (
      (expected !== undefined && digest !== expected) ||
      (header !== null && header !== digest) ||
      (path.startsWith("manifests/") && header === null)
    ) {
      throw new TomcatUpdateError(`Tomcat ${major}: registry digest/body mismatch`);
    }
    return { body, digest };
  };
  const index = await registry(`manifests/${major}-jre21`);
  const parsed = Schema.decodeUnknownSync(Index)(JSON.parse(index.body));
  const environments = [];
  for (const arch of ["amd64", "arm64"] as const) {
    const children = parsed.manifests.filter(
      ({ platform }) => platform?.os === "linux" && platform.architecture === arch,
    );
    const child = children[0];
    if (children.length !== 1 || child === undefined)
      throw new TomcatUpdateError(`Tomcat ${major}: requires exactly one linux/${arch} image`);
    const manifest = Schema.decodeUnknownSync(Manifest)(
      JSON.parse((await registry(`manifests/${child.digest}`, child.digest)).body),
    );
    const config = Schema.decodeUnknownSync(Config)(
      JSON.parse((await registry(`blobs/${manifest.config.digest}`, manifest.config.digest)).body),
    );
    if (config.architecture !== arch)
      throw new TomcatUpdateError(`Tomcat ${major}: child architecture mismatch`);
    const env = (key: string) => {
      const values = config.config.Env.filter((entry) => entry.startsWith(`${key}=`));
      if (values.length !== 1) throw new TomcatUpdateError(`Tomcat ${major}: missing or duplicate ${key}`);
      return values[0]?.slice(key.length + 1) ?? "";
    };
    environments.push({
      version: env("TOMCAT_VERSION"),
      sha512: env("TOMCAT_SHA512"),
      home: env("CATALINA_HOME"),
    });
  }
  const first = environments[0];
  if (
    first === undefined ||
    !new RegExp(`^${major}\\.\\d+\\.\\d+$`, "u").test(first.version) ||
    !/^[a-f0-9]{128}$/u.test(first.sha512) ||
    first.home !== "/usr/local/tomcat" ||
    environments.some((env) => JSON.stringify(env) !== JSON.stringify(first))
  ) {
    throw new TomcatUpdateError(`Tomcat ${major}: platform version/distribution mismatch`);
  }
  const exact = await registry(`manifests/${first.version}-jre21`);
  if (exact.digest !== index.digest)
    throw new TomcatUpdateError(`Tomcat ${major}: exact version tag does not match moving index`);
  return { version: first.version, indexDigest: index.digest };
};

export const resolveTomcatBaseline = async (version: string, request: TomcatFetch) => {
  const github = async (path: string) =>
    JSON.parse(
      await readTomcatResponse(
        await request(`https://api.github.com/repos/apache/tomcat/git/${path}`, {
          headers: { Accept: "application/vnd.github+json" },
        }),
        "Apache tag provenance",
      ),
    );
  const reference = Schema.decodeUnknownSync(Reference)(await github(`ref/tags/${version}`));
  let commit: string;
  switch (reference.object.type) {
    case "commit":
      commit = reference.object.sha;
      break;
    case "tag": {
      const tag = Schema.decodeUnknownSync(Tag)(await github(`tags/${reference.object.sha}`));
      if (tag.tag !== version) throw new TomcatUpdateError("Apache tag version mismatch");
      switch (tag.object.type) {
        case "commit":
          commit = tag.object.sha;
          break;
        case "tag":
          throw new TomcatUpdateError("Apache tag does not resolve to a commit");
        default:
          return assertNever(tag.object.type);
      }
      break;
    }
    default:
      return assertNever(reference.object.type);
  }
  const xml = await readTomcatResponse(
    await request(`https://raw.githubusercontent.com/apache/tomcat/${commit}/conf/server.xml`),
    "Apache server.xml",
  );
  return { upstreamCommit: commit, configSha256: sha256(xml), xml };
};
