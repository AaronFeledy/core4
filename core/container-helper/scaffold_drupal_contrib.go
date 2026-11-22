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

const drupalContribSyncCommand = "drupal-contrib-sync"
const drupalContribOutputs = "composer.json, executable vendor/bin/{drush,phpunit,phpcs,phpcbf}, web/core, and web/index.php"

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

func runDrupalContribSync(args []string, streams helperIO, crash func(string)) int {
	o, err := parseDrupalContribArgs("lando-"+drupalContribSyncCommand, args, streams.env)
	if err != nil {
		return scaffoldResult(err, streams)
	}
	if err := o.checkMount(); err != nil {
		return scaffoldResult(err, streams)
	}
	s := newScaffold(
		drupalContribSyncCommand,
		"Drupal contrib",
		drupalContribSyncCommand,
		fmt.Sprintf("Drupal site at %s is up to date.", o.appRoot),
		drupalContribOutputs,
		o.appRoot,
		streams,
		crash,
	)
	if err := s.acquireLock(); err != nil {
		return scaffoldResult(err, streams)
	}
	defer s.releaseLock()
	// A first build, or one resuming from its manifest, still converges
	// afterwards: inputs may have changed since the generation it resumed.
	// A site without a manifest always converges; with no usable marker
	// record, that reapplies the extension's requirements in full.
	built := false
	if pathExists(s.manifestPath) || !isRegularFile(filepath.Join(o.appRoot, "composer.json")) {
		var done *scaffoldAlreadyComplete
		err := s.executeLocked(scaffoldOptions{
			generate:     func(_ string, manifest *scaffoldManifest) error { return stageDrupalContrib(s, manifest, o) },
			afterPromote: func(manifest *scaffoldManifest) error { return installDrupalContrib(s, manifest, o) },
			complete:     drupalContribComplete,
		})
		if err != nil && !errors.As(err, &done) {
			return scaffoldResult(err, streams)
		}
		built = err == nil
	}
	return scaffoldResult(convergeDrupalContrib(o, s, built), streams)
}

func (o drupalContribOptions) checkMount() error {
	mount := o.extensionPath("custom")
	entries, err := os.ReadDir(mount)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return fmt.Errorf("The extension is not mounted at %s. If you changed recipe.options.project or recipe.options.type, run lando restart so the app mount moves, then rerun lando drupal-contrib-sync.", mount)
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
		return fmt.Errorf("Expected exactly one *.info.yml at the extension root %s; found %d. Keep one info file at the extension root, then rerun lando drupal-contrib-sync.", mount, len(infoFiles))
	}
	infoName := strings.TrimSuffix(infoFiles[0], ".info.yml")
	const remediation = " Set recipe.options.%s to %s in .lando.yml, run lando restart, then rerun lando drupal-contrib-sync."
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
		return fmt.Errorf("Root info.yml must declare a top-level type: module, theme, or profile. Correct the info.yml and recipe.options.type in .lando.yml, run lando restart, then rerun lando drupal-contrib-sync.")
	}
	if infoType != o.extensionType {
		return fmt.Errorf("Root info.yml type (%s) does not match recipe.options.type (%s)."+remediation, infoType, o.extensionType, "type", infoType)
	}
	return nil
}

func installDrupalContrib(s *scaffold, manifest *scaffoldManifest, o drupalContribOptions) error {
	const hook = "composer-install"
	if !manifest.Hooks[hook] || !drupalContribComplete(s.appRoot) {
		if err := s.contribComposer(s.appRoot, "install", []string{"install", "--no-interaction"}); err != nil {
			return err
		}
		manifest.Hooks[hook] = true
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("hook-composer-install")
	}
	return o.prepareTestSite()
}

func (o drupalContribOptions) prepareTestSite() error {
	for _, dir := range []string{"simpletest/browser_output", "default/files/simpletest"} {
		if err := os.MkdirAll(filepath.Join(o.appRoot, "web", "sites", dir), 0o755); err != nil {
			return err
		}
	}
	if path := o.extensionPath("contrib"); pathExists(path) {
		return fmt.Errorf("Drupal contrib sync installed the extension into contrib at %s.", path)
	}
	return nil
}

func drupalContribComplete(root string) bool {
	// The recipe's tasks run these tools from /app/vendor/bin. PHPStan is left out because
	// drupal/core-dev only ships it from Drupal 10, so the extension's require-dev supplies it on 9.
	for _, binary := range []string{"drush", "phpunit", "phpcs", "phpcbf"} {
		if !executableFile(filepath.Join(root, "vendor", "bin", binary)) {
			return false
		}
	}
	return isRegularFile(filepath.Join(root, "composer.json")) &&
		isDirectory(filepath.Join(root, "web", "core")) &&
		isRegularFile(filepath.Join(root, "web", "index.php"))
}
