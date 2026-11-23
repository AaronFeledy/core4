package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func runDrupalCmsScaffold(args []string, streams helperIO, crash func(string)) int {
	intent, err := parseDrupalSiteIntent(args, drupalCmsMajor)
	if errors.Is(err, errDrupalSiteArgs) {
		return reportDrupalScaffoldUsage(streams, drupalCmsScaffoldUsage)
	}
	intent.CMS = true
	appRoot := envValue(streams.env, "LANDO_DRUPAL_CMS_APP_ROOT")
	if appRoot == "" {
		appRoot = "/app"
	}
	s := newScaffold(
		"drupal-cms-scaffold",
		"Drupal CMS",
		"drupal-cms-scaffold",
		fmt.Sprintf("Drupal CMS is already scaffolded at %s.", appRoot),
		"",
		appRoot,
		streams,
		crash,
	)
	err = s.executeDrupalSite(intent, func(stage string, _ *scaffoldManifest) error {
		return stageDrupalCms(s, stage, intent)
	})
	return scaffoldResult(err, streams)
}

func stageDrupalCms(s *scaffold, stage string, intent drupalSiteIntent) error {
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"create-project",
		"drupal/cms:^"+drupalCmsMajor,
		stage,
		"--no-install",
		"--no-scripts",
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not stage the project: %w", err)
	}
	constraint, err := intent.prepareComposer(stage)
	if err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not prepare the Composer layout: %w", err)
	}
	if err := intent.relocateCmsProjectFiles(stage); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not relocate project files: %w", err)
	}
	// Match drupal/recommended-project's allow-plugins so phpcs/phpcbf/phpstan can install their standards.
	for _, plugin := range []string{
		"dealerdirect/phpcodesniffer-composer-installer",
		"phpstan/extension-installer",
	} {
		if err := s.runCommand(s.appRoot, "composer", "--working-dir="+stage, "config", "--no-plugins", "allow-plugins."+plugin, "true"); err != nil {
			return fmt.Errorf("Drupal CMS scaffold could not allow the %s Composer plugin: %w", plugin, err)
		}
	}
	repository := cmsSvgRepositoryJSON()
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"config",
		"repositories.lando-svg-image",
		"--json",
		repository,
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not pin the drupal/svg_image repository: %w", err)
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"require",
		"--no-update",
		"drupal/svg_image:3.x-dev",
		"enshrined/svg-sanitize:^1.0",
		"drupal/drupal_cms_starter:^2",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not require the pinned packages: %w", err)
	}
	if err := s.runCommand(s.appRoot, "composer", intent.devArgs(stage, constraint)...); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not require the project-local lint tools: %w", err)
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"update",
		"--no-install",
		"--no-scripts",
		"--no-plugins",
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not resolve the pinned packages: %w", err)
	}
	if err := intent.verifyCmsProjection(stage, "locked", repository); err != nil {
		return fmt.Errorf("Drupal CMS scaffold rejected the pinned drupal/svg_image security patch: %w", err)
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"audit",
		"--locked",
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold dependency audit failed: %w", err)
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"install", // The CMS template aliases post-install-cmd to @post-update-cmd.
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not install dependencies: %w", err)
	}
	if err := intent.verifyCmsCheckout(s, stage, repository); err != nil {
		return err
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"run-script",
		"post-create-project-cmd",
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not run the post-create-project-cmd hook: %w", err)
	}
	if err := intent.verifyCmsCheckout(s, stage, repository); err != nil {
		return err
	}
	if err := s.runCommand(
		s.appRoot,
		"composer",
		"--working-dir="+stage,
		"audit",
		"--locked",
		"--no-interaction",
	); err != nil {
		return fmt.Errorf("Drupal CMS scaffold dependency audit failed: %w", err)
	}
	return s.stageDrupalSiteFiles(stage, intent)
}

func (i drupalSiteIntent) verifyCmsCheckout(s *scaffold, stage string, repository string) error {
	if err := i.verifyCmsProjection(stage, "installed", repository); err != nil {
		return fmt.Errorf("Drupal CMS scaffold rejected the pinned drupal/svg_image security patch: %w", err)
	}
	directory := filepath.Join(stage, i.Webroot, "modules", "contrib", "svg_image")
	revision, err := s.outputCommand(directory, "git", "-C", directory, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not inspect the drupal/svg_image checkout: %w", err)
	}
	if strings.TrimSpace(revision) != cmsSvgCommit {
		return errors.New("Drupal CMS scaffold installed an unexpected drupal/svg_image checkout.")
	}
	status, err := s.outputCommand(directory, "git", "-C", directory, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("Drupal CMS scaffold could not inspect the drupal/svg_image checkout: %w", err)
	}
	if strings.TrimSpace(status) != "" {
		return errors.New("Drupal CMS scaffold installed an unexpected drupal/svg_image checkout.")
	}
	return nil
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
}
