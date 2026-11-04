export type NpmCredential =
  | { readonly kind: "bearer"; readonly token: string; readonly authorization: string }
  | {
      readonly kind: "basic";
      readonly username: string;
      readonly password: string;
      readonly authorization: string;
    };

const safeCredential = (value: string | undefined): value is string =>
  value !== undefined && value !== "" && !/[\0\r\n]/u.test(value);
const usable = (value: string | undefined): value is string => safeCredential(value) && !/\$\{/u.test(value);

const decodeBase64 = (value: string): string | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
};

export const credentialAt = (config: ReadonlyMap<string, string>, key: string): NpmCredential | undefined => {
  const token = config.get(`${key}:_authToken`);
  if (usable(token)) return { kind: "bearer", token, authorization: `Bearer ${token}` };
  const auth = config.get(`${key}:_auth`);
  if (usable(auth)) {
    const decoded = decodeBase64(auth);
    const colon = decoded?.indexOf(":") ?? -1;
    if (decoded !== undefined && colon > 0 && safeCredential(decoded)) {
      return {
        kind: "basic",
        username: decoded.slice(0, colon),
        password: decoded.slice(colon + 1),
        authorization: `Basic ${auth}`,
      };
    }
  }
  const username = config.get(`${key}:username`);
  const encoded = config.get(`${key}:_password`);
  if (!usable(username) || !usable(encoded)) return undefined;
  const password = decodeBase64(encoded);
  if (!safeCredential(password) || username.includes(":")) return undefined;
  return {
    kind: "basic",
    username,
    password,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
};

export const credentialSecrets = (credential: NpmCredential): readonly string[] => {
  switch (credential.kind) {
    case "bearer":
      return [credential.token, credential.authorization];
    case "basic":
      return [
        credential.password,
        `${credential.username}:${credential.password}`,
        Buffer.from(credential.password).toString("base64"),
        credential.authorization.slice(6),
        credential.authorization,
      ];
    default:
      return credential satisfies never;
  }
};
