import { createHash } from "node:crypto";
import { Schema } from "effect";

export const TOMCAT_MAJORS = ["9", "10", "11"] as const;
export type TomcatMajor = (typeof TOMCAT_MAJORS)[number];
const hex = (length: number) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`, "u"))));
const Pin = Schema.Struct({
  version: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u))),
  indexDigest: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))),
  upstreamCommit: hex(40),
  configSha256: hex(64),
});
export const TomcatPins = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  majors: Schema.Struct({ "9": Pin, "10": Pin, "11": Pin }),
});
export type TomcatPins = typeof TomcatPins.Type;
export type TomcatPin = typeof Pin.Type;
export class TomcatUpdateError extends Error {
  override readonly name = "TomcatUpdateError";
  constructor(readonly detail: string) {
    super(detail);
  }
}
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const activeConfig = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/gu, "");
export const HTTP_CONNECTOR = '<Connector port="8080" protocol="HTTP/1.1"';

/** A deliberately closed contract for the reviewed Apache server.xml layout, not an XML parser. */
export const validateTomcatConfig = (xml: string, major: TomcatMajor): void => {
  const active = activeConfig(xml);
  const tags = [...active.matchAll(/<\/?([A-Za-z]+)\b[^<>]*>/gu)].map((match) => match[0]);
  const shape = tags.map((tag) => tag.replace(/\s[^>]*?(\/?>)$/u, "$1")).join("");
  const expected =
    "<Server><Listener/><Listener/><Listener/><Listener/><Listener/><GlobalNamingResources><Resource/></GlobalNamingResources><Service><Connector/><Engine><Realm><Realm/></Realm><Host><Valve/></Host></Engine></Service></Server>";
  if (shape !== expected || active.replace(/<\?xml[^>]*\?>|<\/?[A-Za-z]+\b[^<>]*>/gu, "").trim() !== "") {
    throw new TomcatUpdateError(`Tomcat ${major}: upstream server.xml structure needs review`);
  }
  for (const tag of tags) {
    if (!/^<\/?[A-Za-z]+(?:\s+[A-Za-z][\w.-]*="[^"<>]*")*\s*\/?>$/u.test(tag)) {
      throw new TomcatUpdateError(`Tomcat ${major}: unexpected XML attribute syntax`);
    }
  }
  const required = [
    '<Server port="8005" shutdown="SHUTDOWN">',
    HTTP_CONNECTOR,
    'className="org.apache.catalina.startup.VersionLoggerListener"',
    'className="org.apache.catalina.core.AprLifecycleListener"',
    'className="org.apache.catalina.core.JreMemoryLeakPreventionListener"',
    'className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"',
    'className="org.apache.catalina.core.ThreadLocalLeakPreventionListener"',
    'className="org.apache.catalina.realm.LockOutRealm"',
    'className="org.apache.catalina.realm.UserDatabaseRealm"',
    'className="org.apache.catalina.valves.AccessLogValve"',
    'pathname="conf/tomcat-users.xml"',
    'unpackWARs="true" autoDeploy="true"',
  ];
  if (
    !xml.includes("Licensed to the Apache Software Foundation") ||
    xml.includes("{{HTTP_PORT}}") ||
    required.some((part) => !active.includes(part)) ||
    active.split(HTTP_CONNECTOR).length !== 2 ||
    xml.split(HTTP_CONNECTOR).length !== 2
  ) {
    throw new TomcatUpdateError(`Tomcat ${major}: upstream server.xml defaults need review`);
  }
};

export const validateTomcatPair = (major: TomcatMajor, pin: TomcatPin, xml: string): void => {
  if (!pin.version.startsWith(`${major}.`) || sha256(xml) !== pin.configSha256) {
    throw new TomcatUpdateError(`Tomcat ${major}: baseline version/hash does not match its pin`);
  }
  validateTomcatConfig(xml, major);
};
