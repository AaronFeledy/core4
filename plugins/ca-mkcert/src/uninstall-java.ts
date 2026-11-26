/**
 * The Java keystore line of the local CA uninstall step. Lando's setup runs mkcert with
 * `TRUST_STORES=system`, but older setups ran `mkcert -install` with Java enabled, and mkcert v1.4.4
 * (`truststore_java.go`) then imported the root into `$JAVA_HOME`'s `cacerts` under the CA's nickname
 * with `$JAVA_HOME/bin/keytool` and store password `changeit`, retrying with sudo when the keystore was
 * not writable. Planning only checks that the keystore exists; it never runs keytool.
 */
import { posix, win32 } from "node:path";
import type { HostPlatform } from "@lando/sdk/schema";

import type { LocalCaHostAccess } from "./uninstall-trust.ts";

const SAFE = /^[\w@%+=:,./\\-]+$/u;

const quoteFor = (platform: HostPlatform, value: string): string => {
  if (SAFE.test(value)) return value;
  return platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
};

/** The `keytool -delete` command for the keystore mkcert would have used, or `undefined` when there is none. */
export const javaKeystoreCommand = (
  platform: HostPlatform,
  access: Pick<LocalCaHostAccess, "env" | "exists">,
  alias: string,
): string | undefined => {
  const javaHome = access.env.JAVA_HOME;
  if (javaHome === undefined || javaHome === "") return undefined;
  const path = platform === "win32" ? win32 : posix;
  // mkcert prefers the JDK 8 `jre/` keystore when both exist.
  const cacerts = [
    path.join(javaHome, "jre", "lib", "security", "cacerts"),
    path.join(javaHome, "lib", "security", "cacerts"),
  ].find((candidate) => access.exists(candidate));
  if (cacerts === undefined) return undefined;
  const keytool = path.join(javaHome, "bin", platform === "win32" ? "keytool.exe" : "keytool");
  const home = access.env.HOME;
  const elevate =
    platform !== "win32" && (home === undefined || home === "" || !cacerts.startsWith(`${home}/`));
  const q = (value: string) => quoteFor(platform, value);
  return `${elevate ? "sudo " : ""}${q(keytool)} -delete -alias ${q(alias)} -keystore ${q(cacerts)} -storepass changeit`;
};
