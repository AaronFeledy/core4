package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type createProjectOptions struct {
	packageName string
	version     string
	noScripts   bool
}

// runCreateProject implements the Composer project creator exposed as
// `lando create-project <package> [<version>] [--no-scripts]`.
func runCreateProject(args []string, streams helperIO, crash func(string)) int {
	options, err := parseCreateProjectArgs(args)
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 1
	}
	appRoot := envValue(streams.env, "LANDO_CREATE_PROJECT_APP_ROOT")
	if appRoot == "" {
		appRoot = envValue(streams.env, "LANDO_PROJECT_MOUNT")
	}
	if appRoot == "" {
		appRoot = "/app"
	}
	s := newScaffold(
		"create-project",
		"create-project",
		"create-project",
		"",
		"composer.json",
		appRoot,
		streams,
		crash,
	)
	err = s.execute(scaffoldOptions{
		preflight: func(resumed bool, _ *scaffoldManifest) error {
			if resumed {
				return nil
			}
			if pathExists(filepath.Join(appRoot, "composer.json")) {
				return fmt.Errorf(
					"create-project refuses %s because composer.json already exists; run lando composer install for an existing project, or start from an empty app root.",
					appRoot,
				)
			}
			return nil
		},
		generate: func(stage string) error {
			return stageCreateProject(s, stage, options)
		},
		afterPromote: func(manifest *scaffoldManifest) error {
			return runCreateProjectHooks(s, manifest, options)
		},
		complete: func(root string) bool {
			return isRegularFile(filepath.Join(root, "composer.json"))
		},
	})
	return scaffoldResult(err, streams)
}

func parseCreateProjectArgs(args []string) (createProjectOptions, error) {
	options := createProjectOptions{}
	for _, argument := range args {
		switch {
		case argument == "--no-scripts":
			options.noScripts = true
		case options.packageName == "":
			options.packageName = argument
		case options.version == "":
			options.version = argument
		default:
			return options, errors.New("create-project accepts one package and an optional version.")
		}
	}
	if options.packageName == "" {
		return options, errors.New("create-project needs a Composer package, for example laravel/laravel.")
	}
	if strings.HasPrefix(options.packageName, "-") {
		return options, fmt.Errorf(
			"create-project package names cannot start with a dash: %s",
			options.packageName,
		)
	}
	if !strings.Contains(options.packageName, "/") {
		return options, fmt.Errorf(
			"create-project package names use vendor/package syntax: %s",
			options.packageName,
		)
	}
	if strings.HasPrefix(options.version, "-") {
		return options, fmt.Errorf("create-project versions cannot start with a dash: %s", options.version)
	}
	return options, nil
}

func stageCreateProject(s *scaffold, stage string, options createProjectOptions) error {
	arguments := []string{"create-project", options.packageName, stage}
	if options.version != "" {
		arguments = append(arguments, options.version)
	}
	arguments = append(arguments, "--no-install", "--no-scripts", "--no-interaction")
	if err := s.runCommand(s.appRoot, "composer", arguments...); err != nil {
		return fmt.Errorf("create-project could not stage %s with Composer: %w", options.packageName, err)
	}
	if !isRegularFile(filepath.Join(stage, "composer.json")) {
		return errors.New("create-project did not stage a composer.json.")
	}
	return nil
}

// runCreateProjectHooks runs Composer's own order after promotion. Each step is
// recorded in the manifest after it succeeds, so a resume skips every recorded
// step. A kill between a hook's exit and that save runs the hook again: a step
// recorded before it runs could be skipped half done, which is worse.
func runCreateProjectHooks(s *scaffold, manifest *scaffoldManifest, options createProjectOptions) error {
	if !options.noScripts && !manifest.Hooks["post-root-package-install"] {
		defined, err := composerScriptDefined(s.appRoot, "post-root-package-install")
		if err != nil {
			return err
		}
		if defined {
			if err := s.runCommand(s.appRoot, "composer", "run-script", "post-root-package-install"); err != nil {
				return errors.New(
					"create-project could not run the post-root-package-install hook; fix the hook and rerun lando create-project.",
				)
			}
			manifest.Hooks["post-root-package-install"] = true
			if err := s.saveManifest(manifest); err != nil {
				return err
			}
			s.point("hook-post-root-package-install")
		}
	}
	if !manifest.Hooks["composer-install"] {
		arguments := []string{"install", "--no-interaction"}
		if options.noScripts {
			arguments = append(arguments, "--no-scripts")
		}
		if err := s.runCommand(s.appRoot, "composer", arguments...); err != nil {
			return errors.New(
				"create-project could not install dependencies; fix the Composer error and rerun lando composer install.",
			)
		}
		manifest.Hooks["composer-install"] = true
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("hook-composer-install")
	}
	if !options.noScripts && !manifest.Hooks["post-create-project-cmd"] {
		defined, err := composerScriptDefined(s.appRoot, "post-create-project-cmd")
		if err != nil {
			return err
		}
		if defined {
			if err := s.runCommand(s.appRoot, "composer", "run-script", "post-create-project-cmd"); err != nil {
				return errors.New(
					"create-project could not run the post-create-project-cmd hook; fix the hook and rerun lando create-project.",
				)
			}
			manifest.Hooks["post-create-project-cmd"] = true
			if err := s.saveManifest(manifest); err != nil {
				return err
			}
			s.point("hook-post-create-project-cmd")
		}
	}
	return nil
}

// composerScriptDefined reports whether the promoted root package declares a
// non-empty listener for one Composer event. Composer 2.10 fails run-script for
// an event with no listeners, and an empty string, array, or mapping counts as
// undefined.
func composerScriptDefined(root string, event string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(root, "composer.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var document struct {
		Scripts map[string]json.RawMessage `json:"scripts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return false, fmt.Errorf("create-project could not read composer.json: %w", err)
	}
	raw, ok := document.Scripts[event]
	if !ok {
		return false, nil
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" || text == `""` || text == "[]" || text == "{}" {
		return false, nil
	}
	return true, nil
}

func scaffoldResult(err error, streams helperIO) int {
	if err == nil {
		return 0
	}
	fmt.Fprintln(streams.stderr, err)
	return 1
}
