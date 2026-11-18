package main

import (
	"fmt"
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
	if !isRegularFile(filepath.Join(o.appRoot, "composer.json")) {
		return contribScaffoldRequired(o.appRoot)
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
	if err := streams.runCommand(o.appRoot, "composer", append(update, "drupal/core-dev", "drush/drush")...); err != nil {
		return fmt.Errorf("Composer could not update Drupal core: %w", err)
	}
	landofile := filepath.Join(o.extensionPath("custom"), ".lando.yml")
	if err := updateContribLandofile(landofile, o.constraint); err != nil {
		return fmt.Errorf("Drupal core now uses %s, but recipe.options.drupal in %s could not be updated; set it there: %w", o.constraint, landofile, err)
	}
	return nil
}

func contribScaffoldRequired(root string) error {
	return fmt.Errorf("Site composer.json is missing at %s. Run lando drupal-contrib-scaffold first.", root)
}
