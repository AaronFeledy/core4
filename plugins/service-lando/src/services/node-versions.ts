export const SUPPORTED_NODE_MAJORS = [
  { major: 22, codename: "jod" },
  { major: 24, codename: "krypton" },
  { major: 26, codename: "lithium" },
] as const;

export type SupportedNodeMajor = (typeof SUPPORTED_NODE_MAJORS)[number]["major"];
export const SUPPORTED_NODE_VERSIONS = ["lts", "22", "24", "26"] as const;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

export const NODE_LTS_MAJOR: SupportedNodeMajor = 26;

export const NODE_ARTIFACTS: Readonly<Record<SupportedNodeVersion, string>> = Object.fromEntries([
  ["lts", `node:${NODE_LTS_MAJOR}`],
  ...SUPPORTED_NODE_MAJORS.map((entry) => [String(entry.major), `node:${entry.major}`] as const),
]) as Readonly<Record<SupportedNodeVersion, string>>;
