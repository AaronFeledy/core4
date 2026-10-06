import { dirname } from "node:path";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeLandoRuntime } from "../../runtime/layer";
import { setupSpec } from "../command-specs/meta/setup";
import {
  type DoctorRenderOptions,
  type DoctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../commands/doctor-report";
import { compiledCommandInputFromArgv } from "../compiled-input";
import {
  activeDeprecationWarnings,
  activeJq,
  activeProjectResultKeys,
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  getActiveCommandInvocation,
  rejectInvalidInvocation,
} from "../compiled-runtime";
import { type RenderContext, runWithRendererHandling } from "../renderer-boundary";

export const runSetup = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:setup", argv)) return;
  const installDir = dirname(process.execPath);
  const input = compiledCommandInputFromArgv("meta:setup", argv);
  const hostProxy = input.flags["host-proxy"];
  if (hostProxy !== undefined && hostProxy !== "auto" && hostProxy !== "none") {
    emitDiagnosticLine("Invalid --host-proxy value. Expected one of: auto, none.");
    process.exitCode = 2;
    return;
  }
  const projectResultKeys = activeProjectResultKeys();
  const jqExpression = activeJq;
  await runWithRendererHandling(
    setupSpec.run({
      installDir,
      flags: input.flags,
    }),
    {
      runtime: makeLandoRuntime(
        cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } }),
      ),
      rendererMode: activeRendererMode,
      resultFormat: activeResultFormat,
      ...(projectResultKeys === undefined ? {} : { projectResultKeys }),
      ...(jqExpression === undefined ? {} : { jqExpression }),
      command: setupSpec.id,
      invocation: getActiveCommandInvocation() ?? {
        commandId: setupSpec.id,
        argv: input.argv,
        args: input.args,
        flags: input.flags,
        cwd: process.cwd(),
      },
      resultSchema: setupSpec.resultSchema,
      deprecationWarnings: activeDeprecationWarnings,
      render: (value, ctx) => setupSpec.render?.(value, undefined, ctx),
      formatError: (error) => {
        const message = commandErrorMessage(error);
        return activeRendererMode === "json" ? message : `${message}\nLANDO_INSTALL_DIR="${installDir}"`;
      },
    },
  );
};

export const renderCompiledDoctorReport = (
  value: DoctorReport,
  ctx: RenderContext,
  options: DoctorRenderOptions = {},
): string | undefined => {
  if (ctx.format === "ndjson") return renderDoctorReportAsNdjson(value);
  return renderDoctorReport(value, ctx, options);
};
