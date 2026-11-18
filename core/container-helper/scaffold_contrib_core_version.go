package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func runDrupalContribCoreVersion(args []string, streams helperIO) int {
	o, err := parseDrupalContribArgs("lando-drupal-contrib-core-version", args, streams.env)
	if err == nil {
		err = updateDrupalContribCore(o, streams)
	}
	return scaffoldResult(err, streams)
}

func updateDrupalContribCore(o drupalContribOptions, streams helperIO) error {
	if !isDirectory(o.appRoot) {
		return contribScaffoldRequired(o.appRoot)
	}
	lock, err := acquireScaffoldLock(o.appRoot)
	if err != nil {
		return err
	}
	defer lock.release()
	if !pathExists(scaffoldMarkerPath(o.appRoot, drupalContribScaffoldCommand)) || !drupalContribComplete(o.appRoot) {
		return contribScaffoldRequired(o.appRoot)
	}
	landofile := filepath.Join(o.extensionPath("custom"), ".lando.yml")
	if _, err := prepareContribLandofile(landofile, o.constraint); err != nil {
		return fmt.Errorf("recipe.options.drupal in %s could not be updated; set it there: %w", landofile, err)
	}
	site, err := readContribComposer(o.appRoot)
	if err != nil {
		return err
	}
	core := []string{"drupal/core-recommended"}
	for _, optional := range []string{"drupal/core-composer-scaffold", "drupal/core-project-message"} {
		if _, present := site.Require[optional]; present {
			core = append(core, optional)
		}
	}
	versions := make([]string, 0, len(core))
	for _, name := range core {
		versions = append(versions, name+":"+o.constraint)
	}
	if err := contribComposerRequire(streams, o.appRoot, false, versions...); err != nil {
		return err
	}
	if err := contribComposerRequire(streams, o.appRoot, true, "drupal/core-dev:"+o.constraint); err != nil {
		return err
	}
	update := []string{"--working-dir=" + o.appRoot, "update", "--with-all-dependencies", "--no-interaction"}
	update = append(update, core...)
	restore, err := unlockInstalledSiteDirectory(filepath.Join(o.appRoot, "web", "sites", "default"))
	if err != nil {
		return err
	}
	err = streams.runCommand(o.appRoot, "composer", append(update, "drupal/core-dev", "drush/drush")...)
	if restoreErr := restore(); restoreErr != nil {
		err = errors.Join(err, restoreErr)
	}
	if err != nil {
		return fmt.Errorf("Composer could not update Drupal core: %w", err)
	}
	if err := updateContribLandofile(landofile, o.constraint); err != nil {
		return fmt.Errorf("Drupal core now uses %s, but recipe.options.drupal in %s could not be updated; set it there: %w", o.constraint, landofile, err)
	}
	return nil
}

// unlockInstalledSiteDirectory gives the owner write access to a site directory
// Drupal's installer made read-only, so Composer's core scaffold can replace
// the default.* files there. The returned function restores the original mode.
func unlockInstalledSiteDirectory(dir string) (func() error, error) {
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return func() error { return nil }, nil
	}
	if err != nil {
		return nil, err
	}
	mode := info.Mode().Perm()
	if !info.IsDir() || mode&0o200 != 0 {
		return func() error { return nil }, nil
	}
	if err := os.Chmod(dir, mode|0o200); err != nil {
		return nil, fmt.Errorf("Could not make %s writable for the Drupal core update: %w", dir, err)
	}
	return func() error { return os.Chmod(dir, mode) }, nil
}

func contribScaffoldRequired(root string) error {
	return fmt.Errorf("Drupal contrib is not fully scaffolded at %s. Run lando drupal-contrib-scaffold first.", root)
}
