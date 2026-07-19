/**
 * Compiled-CLI dispatch for `app:*` topic commands (plus their bare aliases).
 *
 * Each branch matches the canonical id or one of its accepted alias spellings,
 * runs the corresponding app-lifecycle / exec-shell adapter, and reports back to
 * `runCompiledCli` whether it handled the invocation. Returns `false` when the
 * argv does not belong to this topic so the next topic dispatcher can try.
 */
import {
  runAppCacheRefresh,
  runAppConfig,
  runAppConfigLint,
  runAppConfigTranslate,
  runAppConfigVerb,
  runAppIncludesUpdate,
  runAppIncludesVerify,
  runDestroy,
  runInfo,
  runLogs,
  runOpen,
  runPull,
  runPush,
  runRebuild,
  runRemoteAdd,
  runRemoteEnvList,
  runRemoteList,
  runRemoteRemove,
  runRemoteSetup,
  runRemoteTest,
  runRestart,
  runShare,
  runShareList,
  runShareStop,
  runStart,
  runStop,
} from "./cli-adapters/app-lifecycle.ts";
import { runExec, runShell, runSsh } from "./cli-adapters/exec-shell.ts";
import { runWithProcessAbortSignal } from "./compiled-runtime.ts";

export const dispatchAppCommand = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] === "start" || argv[0] === "app:start") {
    await runStart();
    return true;
  }

  if (argv[0] === "stop" || argv[0] === "app:stop") {
    await runStop();
    return true;
  }

  if (argv[0] === "info" || argv[0] === "app:info") {
    await runInfo(argv.slice(1));
    return true;
  }

  if (argv[0] === "open" || argv[0] === "app:open") {
    await runOpen(argv.slice(1));
    return true;
  }

  if (argv[0] === "destroy" || argv[0] === "app:destroy") {
    await runDestroy(argv.slice(1));
    return true;
  }

  if (argv[0] === "restart" || argv[0] === "app:restart") {
    await runRestart();
    return true;
  }

  if (argv[0] === "rebuild" || argv[0] === "app:rebuild") {
    await runRebuild();
    return true;
  }

  if (argv[0] === "logs" || argv[0] === "app:logs") {
    await runLogs(argv.slice(1));
    return true;
  }

  if (argv[0] === "pull" || argv[0] === "app:pull" || argv[0] === "pull:app") {
    await runPull(argv.slice(1));
    return true;
  }

  if (argv[0] === "push" || argv[0] === "app:push" || argv[0] === "push:app") {
    await runPush(argv.slice(1));
    return true;
  }

  if (argv[0] === "share" || argv[0] === "app:share" || argv[0] === "share:app") {
    await runShare(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:share:list" ||
    argv[0] === "share:app:list" ||
    argv[0] === "share:list:app" ||
    argv[0] === "app:list:share" ||
    argv[0] === "list:app:share" ||
    argv[0] === "list:share:app"
  ) {
    await runShareList(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:share:stop" ||
    argv[0] === "share:app:stop" ||
    argv[0] === "share:stop:app" ||
    argv[0] === "app:stop:share" ||
    argv[0] === "stop:app:share" ||
    argv[0] === "stop:share:app"
  ) {
    await runShareStop(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:list" ||
    argv[0] === "remote:app:list" ||
    argv[0] === "remote:list:app" ||
    argv[0] === "app:list:remote" ||
    argv[0] === "list:app:remote" ||
    argv[0] === "list:remote:app"
  ) {
    await runRemoteList(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:add" ||
    argv[0] === "remote:app:add" ||
    argv[0] === "remote:add:app" ||
    argv[0] === "app:add:remote" ||
    argv[0] === "add:app:remote" ||
    argv[0] === "add:remote:app"
  ) {
    await runRemoteAdd(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:remove" ||
    argv[0] === "remote:app:remove" ||
    argv[0] === "remote:remove:app" ||
    argv[0] === "app:remove:remote" ||
    argv[0] === "remove:app:remote" ||
    argv[0] === "remove:remote:app"
  ) {
    await runRemoteRemove(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:test" ||
    argv[0] === "remote:app:test" ||
    argv[0] === "remote:test:app" ||
    argv[0] === "app:test:remote" ||
    argv[0] === "test:app:remote" ||
    argv[0] === "test:remote:app"
  ) {
    await runRemoteTest(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:setup" ||
    argv[0] === "remote:app:setup" ||
    argv[0] === "remote:setup:app" ||
    argv[0] === "app:setup:remote" ||
    argv[0] === "setup:app:remote" ||
    argv[0] === "setup:remote:app"
  ) {
    await runRemoteSetup(argv.slice(1));
    return true;
  }

  if (
    argv[0] === "app:remote:env:list" ||
    argv[0] === "app:env:remote:list" ||
    argv[0] === "env:app:remote:list" ||
    argv[0] === "env:remote:app:list" ||
    argv[0] === "env:remote:list:app" ||
    argv[0] === "app:remote:list:env" ||
    argv[0] === "remote:app:env:list" ||
    argv[0] === "remote:env:app:list" ||
    argv[0] === "remote:env:list:app" ||
    argv[0] === "remote:list:app:env" ||
    argv[0] === "remote:list:env:app"
  ) {
    await runRemoteEnvList(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:lint") {
    await runAppConfigLint(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:translate") {
    await runAppConfigTranslate(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:includes:update") {
    await runAppIncludesUpdate(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:includes:verify") {
    await runAppIncludesVerify(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:set") {
    await runAppConfigVerb("set", argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:unset") {
    await runAppConfigVerb("unset", argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:edit") {
    await runAppConfigVerb("edit", argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config:validate") {
    await runAppConfigVerb("validate", argv.slice(1));
    return true;
  }

  if (argv[0] === "app:config") {
    await runAppConfig(argv.slice(1));
    return true;
  }

  if (argv[0] === "app:cache:refresh") {
    await runAppCacheRefresh();
    return true;
  }

  if (argv[0] === "exec" || argv[0] === "app:exec") {
    await runExec(argv.slice(1));
    return true;
  }

  if (argv[0] === "ssh" || argv[0] === "app:ssh") {
    await runSsh(argv.slice(1));
    return true;
  }

  if (argv[0] === "shell" || argv[0] === "app:shell") {
    await runWithProcessAbortSignal((signal) => runShell(argv.slice(1), { signal }));
    return true;
  }

  return false;
};
