package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

func convergeDrupalContrib(o drupalContribOptions, s *scaffold) error {
	streams := s.streams
	site, err := readContribComposer(o.appRoot)
	if err != nil {
		return err
	}
	extension, err := o.readExtensionComposer()
	if err != nil {
		return err
	}
	previous := loadContribSyncRecord(s.markerPath)
	desired, err := desiredContribRequirements(o.constraint, site, extension, previous)
	if err != nil {
		return err
	}
	changes := planContribChanges(previous, desired, site)
	if len(changes.names) == 0 && drupalContribComplete(o.appRoot) {
		_, err := fmt.Fprintln(streams.stdout, s.completeMessage)
		return err
	}

	for _, dev := range []bool{false, true} {
		if err := streams.contribComposerEdit(o.appRoot, "require", dev, changes.require[dev]); err != nil {
			return err
		}
	}
	for _, dev := range []bool{false, true} {
		if err := streams.contribComposerEdit(o.appRoot, "remove", dev, changes.remove[dev]); err != nil {
			return err
		}
	}

	step := "install"
	args := []string{"--working-dir=" + o.appRoot, "install", "--no-interaction"}
	if len(changes.names) > 0 {
		step = "update"
		args = append([]string{"--working-dir=" + o.appRoot, "update", "--with-all-dependencies", "--no-interaction"}, changes.names...)
	}
	restore, err := unlockInstalledSiteDirectory(filepath.Join(o.appRoot, "web", "sites", "default"))
	if err != nil {
		return err
	}
	runErr := streams.contribComposer(o.appRoot, step, args)
	if err := errors.Join(runErr, restore()); err != nil {
		return err
	}
	if err := o.prepareTestSite(); err != nil {
		return err
	}
	if !drupalContribComplete(o.appRoot) {
		return fmt.Errorf("Drupal contrib sync did not produce %s.", drupalContribOutputs)
	}
	return desired.save(s.markerPath)
}

type contribChanges struct {
	require map[bool][]string
	remove  map[bool][]string
	names   []string
}

func planContribChanges(previous, desired contribSyncRecord, site contribComposerManifest) contribChanges {
	changes := contribChanges{require: make(map[bool][]string), remove: make(map[bool][]string)}
	changed := make(map[string]bool)
	for _, dev := range []bool{false, true} {
		for name, constraint := range desired.bucket(dev) {
			if old, present := previous.bucket(dev)[name]; present && old == constraint {
				continue
			}
			changed[name] = true
			if current, present := site.bucket(dev)[name]; !present || current != constraint {
				changes.require[dev] = append(changes.require[dev], name+":"+constraint)
			}
		}
		for name := range previous.bucket(dev) {
			if _, kept := desired.bucket(dev)[name]; kept {
				continue
			}
			if _, moved := desired.bucket(!dev)[name]; moved {
				continue // Composer require moves a package between buckets.
			}
			changed[name] = true
			for _, siteDev := range []bool{false, true} {
				if _, present := site.bucket(siteDev)[name]; present {
					changes.remove[siteDev] = append(changes.remove[siteDev], name)
				}
			}
		}
	}
	for name := range changed {
		changes.names = append(changes.names, name)
	}
	sort.Strings(changes.names)
	return changes
}

// Drupal's installer removes write access; Composer scaffold replaces files
// in this directory. Restore the installed site's original mode afterward.
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
		return nil, fmt.Errorf("Could not make %s writable for Drupal contrib sync: %w", dir, err)
	}
	return func() error { return os.Chmod(dir, mode) }, nil
}
