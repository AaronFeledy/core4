package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

var (
	contribProjectPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	contribConstraintPattern = regexp.MustCompile(`^[v0-9^~<>=*.,@| a-zA-Z-]+$`)
)

type drupalContribOptions struct {
	appRoot       string
	extensionType string
	project       string
	constraint    string
}

func parseDrupalContribArgs(command string, args []string, env map[string]string) (drupalContribOptions, error) {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			return drupalContribOptions{}, fmt.Errorf("%s does not accept the option %s.", command, arg)
		}
	}
	if len(args) != 3 {
		return drupalContribOptions{}, fmt.Errorf("Usage: %s <type> <project> <constraint>", command)
	}
	switch args[0] {
	case "module", "theme", "profile":
	default:
		return drupalContribOptions{}, errors.New("Drupal contrib type must be module, theme, or profile.")
	}
	if !contribProjectPattern.MatchString(args[1]) {
		return drupalContribOptions{}, errors.New("Drupal contrib project must be a machine name matching the root *.info.yml.")
	}
	if !contribConstraintPattern.MatchString(args[2]) {
		return drupalContribOptions{}, errors.New("Drupal contrib core constraint is invalid.")
	}
	root := envValue(env, "LANDO_DRUPAL_CONTRIB_APP_ROOT")
	if root == "" {
		root = "/app"
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return drupalContribOptions{}, err
	}
	return drupalContribOptions{appRoot: root, extensionType: args[0], project: args[1], constraint: args[2]}, nil
}

func (o drupalContribOptions) extensionPath(location string) string {
	return filepath.Join(o.appRoot, "web", o.extensionType+"s", location, o.project)
}

func runDrupalContribScaffold(args []string, streams helperIO, crash func(string)) int {
	const command = "drupal-contrib-scaffold"
	o, err := parseDrupalContribArgs("lando-"+command, args, streams.env)
	if err != nil {
		return scaffoldResult(err, streams)
	}
	// A missing app root cannot contain the bind. Don't create it just to take a lock.
	if !isDirectory(o.appRoot) {
		return scaffoldResult(o.checkMount(), streams)
	}
	s := newScaffold(
		command,
		"Drupal contrib",
		command,
		fmt.Sprintf("Drupal contrib is already scaffolded at %s.", o.appRoot),
		"composer.json, executable vendor/bin/{drush,phpunit,phpcs}, web/core, and web/index.php",
		o.appRoot,
		streams,
		crash,
	)
	return scaffoldResult(s.execute(scaffoldOptions{
		preflight:    func(bool, *scaffoldManifest) error { return o.checkMount() },
		generate:     func(stage string) error { return stageDrupalContrib(s, stage, o) },
		afterPromote: func(manifest *scaffoldManifest) error { return installDrupalContrib(s, manifest, o) },
		complete:     drupalContribComplete,
	}), streams)
}

func (o drupalContribOptions) checkMount() error {
	mount := o.extensionPath("custom")
	entries, err := os.ReadDir(mount)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return fmt.Errorf("The extension is not mounted at %s. Run lando rebuild so the app mount is recreated.", mount)
	}
	if err != nil {
		return err
	}
	var infoFiles []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".info.yml") {
			infoFiles = append(infoFiles, entry.Name())
		}
	}
	if len(infoFiles) != 1 {
		return fmt.Errorf("Expected exactly one *.info.yml at the extension root %s.", mount)
	}
	infoName := strings.TrimSuffix(infoFiles[0], ".info.yml")
	const remediation = " Set recipe.options.%s to %s in .lando.yml, run lando rebuild, then rerun lando drupal-contrib-scaffold."
	if infoName != o.project {
		return fmt.Errorf("Root info.yml machine name (%s) does not match recipe.options.project (%s)."+remediation, infoName, o.project, "project", infoName)
	}
	infoPath := filepath.Join(mount, infoFiles[0])
	if !isRegularFile(infoPath) {
		return fmt.Errorf("Root info.yml at %s must be a regular file.", infoPath)
	}
	data, err := os.ReadFile(infoPath)
	if err != nil {
		return err
	}
	infoType := yamlRootString(string(data), "type")
	if infoType == "" {
		return fmt.Errorf("Root info.yml must declare a top-level type: module, theme, or profile. Correct the info.yml and recipe.options.type in .lando.yml, run lando rebuild, then rerun lando drupal-contrib-scaffold.")
	}
	if infoType != o.extensionType {
		return fmt.Errorf("Root info.yml type (%s) does not match recipe.options.type (%s)."+remediation, infoType, o.extensionType, "type", infoType)
	}
	return nil
}

func installDrupalContrib(s *scaffold, manifest *scaffoldManifest, o drupalContribOptions) error {
	const hook = "composer-install"
	if !manifest.Hooks[hook] {
		if err := s.runCommand(s.appRoot, "composer", "install", "--no-interaction"); err != nil {
			return fmt.Errorf("Drupal contrib scaffold could not install dependencies; fix the Composer error and rerun lando drupal-contrib-scaffold: %w", err)
		}
		manifest.Hooks[hook] = true
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("hook-composer-install")
	}
	for _, dir := range []string{"simpletest/browser_output", "default/files/simpletest"} {
		if err := os.MkdirAll(filepath.Join(s.appRoot, "web", "sites", dir), 0o755); err != nil {
			return err
		}
	}
	if path := o.extensionPath("contrib"); pathExists(path) {
		return fmt.Errorf("Drupal contrib scaffold installed the extension into contrib at %s.", path)
	}
	return nil
}

func drupalContribComplete(root string) bool {
	return isRegularFile(filepath.Join(root, "composer.json")) &&
		executableFile(filepath.Join(root, "vendor", "bin", "drush")) &&
		executableFile(filepath.Join(root, "vendor", "bin", "phpunit")) &&
		executableFile(filepath.Join(root, "vendor", "bin", "phpcs")) &&
		isDirectory(filepath.Join(root, "web", "core")) &&
		isRegularFile(filepath.Join(root, "web", "index.php"))
}
