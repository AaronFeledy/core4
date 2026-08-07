import { Layer } from "effect";

import {
  type ResolveLandofileIncludesOptions,
  type UpdateLandofileIncludesOptions,
  type VerifyLandofileIncludesOptions,
  resolveLandofileIncludes as resolveLandofileIncludesPackage,
  updateLandofileIncludes as updateLandofileIncludesPackage,
  verifyLandofileIncludes as verifyLandofileIncludesPackage,
} from "@lando/landofile/includes";
import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofile as lintLandofilePackage } from "@lando/landofile/lint";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import {
  findDiscoveredLandofilePath,
  loadLandofileFile as loadLandofileFilePackage,
  loadLandofileLayers as loadLandofileLayersPackage,
  makeLandofileServiceLive,
} from "@lando/landofile/service";
import {
  type RenderLandofileTemplateOptions,
  buildTemplateEngineRegistry,
  renderLandofileTemplate as renderLandofileTemplatePackage,
} from "@lando/landofile/template-render";
import { landofileRuntimeInputs } from "../composition.ts";

export const makeBundledTemplateEngineRegistry = (inputs: LandofileRuntimeInputs) =>
  buildTemplateEngineRegistry(inputs.templates.modules);

export const renderLandofileTemplate = (options: RenderLandofileTemplateOptions) =>
  renderLandofileTemplatePackage({
    ...options,
    registry: options.registry ?? makeBundledTemplateEngineRegistry(landofileRuntimeInputs()),
  });

export const lintLandofile = (options: LintLandofileOptions = {}) =>
  lintLandofilePackage({ ...options, templates: options.templates ?? landofileRuntimeInputs().templates });

export const resolveLandofileIncludes = (options: ResolveLandofileIncludesOptions) =>
  resolveLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs().ports });

export const updateLandofileIncludes = (options: UpdateLandofileIncludesOptions) =>
  updateLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs().ports });

export const verifyLandofileIncludes = (options: VerifyLandofileIncludesOptions) =>
  verifyLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs().ports });

export { findDiscoveredLandofilePath };

export const loadLandofileFile = (
  filePath: string,
  context?: Parameters<typeof loadLandofileFilePackage>[1],
) => loadLandofileFilePackage(filePath, context, landofileRuntimeInputs());

export const loadLandofileLayers = (appRoot: string, canonicalPath: string) =>
  loadLandofileLayersPackage(appRoot, canonicalPath, landofileRuntimeInputs());

export const makeEngineLandofileServiceLive = (inputs: LandofileRuntimeInputs) =>
  makeLandofileServiceLive(inputs);

export const LandofileServiceLive = Layer.suspend(() => makeLandofileServiceLive(landofileRuntimeInputs()));
