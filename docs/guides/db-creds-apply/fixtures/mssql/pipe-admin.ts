const lando = process.env.LANDO_SCENARIO_E2E_BINARY ?? process.execPath;
const apply = Bun.argv[2] === "apply";
const child = Bun.spawn(
  [lando, "db:creds:apply", "--service", "db", "--format=json", ...(apply ? ["--yes"] : []), "-"],
  {
    env: { ...process.env, BUN_BE_BUN: undefined, LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined },
    stdin: new Blob(["MssqlOutOfBand3!"]),
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);

export {};
