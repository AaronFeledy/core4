import { request } from "node:http";
import { cwd, env, exit, stderr, stdout } from "node:process";

const forwardedEnvNames: ReadonlyArray<string> = ["LANG", "TERM"];
const agentEnvNames: ReadonlyArray<string> = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "OPENCODE",
  "COPILOT_CLI",
  "GEMINI_CLI",
  "AGENT",
  "CI",
];
const forwardedEnvPrefixes: ReadonlyArray<string> = ["LANDO_", "LC_"];

type ShimRequest = {
  readonly sessionId: string;
  readonly appId: string;
  readonly token: string;
  readonly callerService: string;
  readonly depth: number;
  readonly request: {
    readonly _tag: "runLando";
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly tty: boolean;
    readonly env?: Readonly<Record<string, string>>;
  };
};

const shouldForwardEnv = (name: string): boolean =>
  forwardedEnvPrefixes.some((prefix) => name.startsWith(prefix)) ||
  forwardedEnvNames.includes(name) ||
  agentEnvNames.includes(name);

const filteredEnv = (): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && shouldForwardEnv(name)) output[name] = value;
  }
  return output;
};

const requiredEnv = (name: string): string => {
  const value = env[name];
  if (value !== undefined && value.length > 0) return value;
  stderr.write(`Missing ${name} for host-proxy runLando.\n`);
  exit(127);
};

const writeFrame = (line: string): number | undefined => {
  const decoded: unknown = JSON.parse(line);
  if (typeof decoded !== "object" || decoded === null || !("kind" in decoded)) return undefined;
  if (decoded.kind === "stdout" && "chunk" in decoded && typeof decoded.chunk === "string")
    stdout.write(decoded.chunk);
  if (decoded.kind === "stderr" && "chunk" in decoded && typeof decoded.chunk === "string")
    stderr.write(decoded.chunk);
  if (decoded.kind === "error" && "message" in decoded && typeof decoded.message === "string") {
    stderr.write(`${decoded.message}\n`);
    return 1;
  }
  if (decoded.kind === "exit" && "code" in decoded && typeof decoded.code === "number") return decoded.code;
  return undefined;
};

const writeAndExit = (socketPath: string, payload: ShimRequest): void => {
  let buffered = "";
  let exitCode = 1;
  const req = request(
    {
      socketPath,
      method: "POST",
      path: "/runLando",
      headers: {
        authorization: `Bearer ${payload.token}`,
        "content-type": "application/json",
        "x-lando-host-proxy-app": payload.appId,
        "x-lando-host-proxy-session": payload.sessionId,
        "x-lando-host-proxy-caller": payload.callerService,
        "x-lando-host-proxy-depth": String(payload.depth),
      },
    },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) exitCode = writeFrame(line) ?? exitCode;
          newline = buffered.indexOf("\n");
        }
      });
      res.on("end", () => exit(exitCode));
    },
  );
  req.on("error", (error) => {
    stderr.write(`${error.message}\n`);
    exit(127);
  });
  req.end(JSON.stringify(payload.request));
};

const socketPath = requiredEnv("LANDO_HOST_PROXY_SOCKET");
const currentDepth = Number(env.LANDO_HOST_PROXY_DEPTH ?? "0");
const depth = Number.isFinite(currentDepth) ? currentDepth : 0;
writeAndExit(socketPath, {
  sessionId: requiredEnv("LANDO_HOST_PROXY_SESSION"),
  appId: requiredEnv("LANDO_HOST_PROXY_APP"),
  token: requiredEnv("LANDO_HOST_PROXY_TOKEN"),
  callerService: env.LANDO_HOST_PROXY_CALLER ?? "unknown",
  depth,
  request: {
    _tag: "runLando",
    argv: process.argv.slice(2),
    cwd: cwd(),
    tty: Boolean(stdout.isTTY),
    env: filteredEnv(),
  },
});
