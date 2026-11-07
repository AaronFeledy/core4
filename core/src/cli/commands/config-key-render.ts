import type { ConfigKeyDescription } from "@lando/sdk/schema";

export const renderConfigKeyDescription = (description: ConfigKeyDescription, document: string): string => {
  const lines = [
    `${description.key === "" ? document : `\`${description.key}\``} takes ${description.summary}.`,
  ];
  if (description.description !== undefined) lines.push(description.description);
  if ("default" in description) lines.push(`Default: ${JSON.stringify(description.default)}`);
  if (description.keys !== undefined) {
    const width = Math.max(3, ...description.keys.map(({ key }) => key.length));
    lines.push(`${"KEY".padEnd(width)}  TAKES`);
    for (const child of description.keys) lines.push(`${child.key.padEnd(width)}  ${child.summary}`);
  }
  return lines.join("\n");
};
