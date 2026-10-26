import { isPlainRecord } from "@lando/sdk/landofile";
import type { ParsedPendingSite, ValidationIssuePath } from "@lando/sdk/schema";

const child = (value: unknown, key: string | number): unknown =>
  Array.isArray(value) && typeof key === "number"
    ? value[key]
    : isPlainRecord(value)
      ? value[String(key)]
      : undefined;

export const decodedPendingSites = (
  authored: unknown,
  decoded: unknown,
  sites: readonly ParsedPendingSite[],
): readonly ParsedPendingSite[] =>
  sites.flatMap((site) => {
    let input = authored;
    let output = decoded;
    const path: (string | number)[] = [];
    const remaining = [...site.path];
    while (true) {
      const field = path.at(-1);
      if ((typeof input === "string" || Array.isArray(input)) && isPlainRecord(output)) {
        const key =
          path.length === 2 && path[0] === "tooling" && Object.hasOwn(output, "cmd")
            ? "cmd"
            : field === "appMount"
              ? "target"
              : field === "build"
                ? "context"
                : field === "healthcheck"
                  ? "command"
                  : typeof field === "number" && (path.at(-2) === "configs" || path.at(-2) === "secrets")
                    ? "source"
                    : typeof field === "number" && path.at(-2) === "dependsOn"
                      ? "service"
                      : undefined;
        if (key !== undefined) {
          path.push(key);
          output = output[key];
        }
      }
      if (typeof input === "string" && Array.isArray(output)) {
        path.push(0);
        output = output[0];
      }
      const key = remaining.shift();
      if (key === undefined) break;
      if (field === "dependsOn" && isPlainRecord(input) && Array.isArray(output)) {
        const index = Object.keys(input).indexOf(String(key));
        if (index < 0) return [];
        path.push(index);
        input = input[String(key)];
        output = output[index];
        continue;
      }
      let destination: string | number = key;
      if (
        field === "security" &&
        ["cas", "certificate-authority", "certificate-authorities"].includes(String(key))
      )
        destination = "ca";
      if (field === "build" && key === "dockerfile_inline") destination = "dockerfileInline";
      if (field === "healthcheck" && key === "test") {
        destination = "command";
        const test = child(input, key);
        if (Array.isArray(test) && typeof remaining[0] === "number") {
          const index = remaining.shift();
          if (typeof index !== "number" || index === 0) return [];
          if (test[0] === "CMD") remaining.unshift(index - 1);
        }
      }
      input = child(input, key);
      output = child(output, destination);
      path.push(destination);
      if (output === undefined) return [];
    }
    return [{ ...site, path: path satisfies ValidationIssuePath }];
  });
