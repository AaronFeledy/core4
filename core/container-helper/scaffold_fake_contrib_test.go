package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

func fakeContribComposer(args []string, env map[string]string) int {
	dir, err := os.Getwd()
	if err != nil || len(args) == 0 {
		return 2
	}
	if override, ok := strings.CutPrefix(args[0], "--working-dir="); ok {
		dir, args = override, args[1:]
	}
	switch args[0] {
	case "create-project":
		stage := args[len(args)-1]
		if err := os.WriteFile(filepath.Join(stage, "README.md"), []byte("recommended project\n"), 0o644); err != nil {
			return 2
		}
		if env["LANDO_TEST_COMPOSER_MODE"] != "missing-stage-json" {
			writeFakeJSON(filepath.Join(stage, "composer.json"), map[string]any{
				"require": map[string]string{
					"drupal/core-recommended": "^11.2", "drupal/core-composer-scaffold": "^11.2",
					"drupal/core-project-message": "^11.2", "acme/root": "^1",
				},
				"require-dev": map[string]string{"acme/root-dev": "^1"},
			})
		}
	case "require", "remove":
		if env["LANDO_TEST_COMPOSER_MODE"] == "missing-stage-json" {
			return 0
		}
		path := filepath.Join(dir, "composer.json")
		manifest := readFakeJSON(path)
		bucket, other := "require", "require-dev"
		if slices.Contains(args, "--dev") {
			bucket, other = other, bucket
		}
		requires, ok := manifest[bucket].(map[string]any)
		if !ok {
			requires = map[string]any{}
			manifest[bucket] = requires
		}
		for _, arg := range args[1:] {
			if strings.HasPrefix(arg, "--") {
				continue
			}
			if args[0] == "remove" {
				delete(requires, arg)
				continue
			}
			name, version, ok := strings.Cut(arg, ":")
			if !ok {
				return 2
			}
			requires[name] = version
			if opposite, ok := manifest[other].(map[string]any); ok {
				delete(opposite, name)
			}
		}
		writeFakeJSON(path, manifest)
	case "install":
		if dir != env["LANDO_DRUPAL_CONTRIB_APP_ROOT"] || !isRegularFile(filepath.Join(dir, "composer.json")) {
			return 2
		}
		for _, subdir := range []string{"vendor/bin", "web/core"} {
			if err := os.MkdirAll(filepath.Join(dir, subdir), 0o755); err != nil {
				return 2
			}
		}
		if env["LANDO_TEST_KILL_AT"] == "during-contrib-install" && env["LANDO_TEST_KILL"] == "1" {
			if err := syscall.Kill(os.Getppid(), syscall.SIGKILL); err != nil {
				return 2
			}
			return 42
		}
		for _, executable := range []string{"drush", "phpunit", "phpcs"} {
			mode := os.FileMode(0o755)
			if executable == env["LANDO_TEST_COMPOSER_MODE"] {
				mode = 0o644
			}
			if err := os.WriteFile(filepath.Join(dir, "vendor", "bin", executable), []byte("#!/bin/sh\n"), mode); err != nil {
				return 2
			}
		}
		if err := os.WriteFile(filepath.Join(dir, "web", "index.php"), []byte("<?php\n"), 0o644); err != nil {
			return 2
		}
	case "update":
		// Composer's core scaffold replaces files in sites/default, which Drupal's
		// installer leaves read-only. Check the bit: tests may run as root.
		if info, err := os.Stat(filepath.Join(dir, "web", "sites", "default")); err == nil && info.Mode().Perm()&0o200 == 0 {
			return 43
		}
		if env["LANDO_TEST_COMPOSER_MODE"] == "fail-update" {
			return 42
		}
	default:
		return 2
	}
	return 0
}
