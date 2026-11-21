package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
)

// convergeDrupalContrib brings a built site in line with its inputs. It
// reports an unchanged site unless this run just built it.
func convergeDrupalContrib(o drupalContribOptions, s *scaffold, built bool) error {
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
		if built {
			return nil
		}
		_, err := fmt.Fprintln(s.streams.stdout, s.completeMessage)
		return err
	}

	// Like composer require, a sync that fails leaves the manifest as it was,
	// so an entry it added can't linger and look like one the site owns.
	manifests, err := snapshotContribManifests(o.appRoot)
	if err != nil {
		return err
	}
	if err := s.applyContribChanges(changes); err != nil {
		return errors.Join(err, manifests.restore())
	}
	return finishContribSync(o, s, desired)
}

func (s *scaffold) applyContribChanges(changes contribChanges) error {
	root := s.appRoot
	for _, step := range []string{"require", "remove"} {
		edits := changes.require
		if step == "remove" {
			edits = changes.remove
		}
		for _, dev := range []bool{false, true} {
			if err := s.contribComposerEdit(root, step, dev, edits[dev]); err != nil {
				return err
			}
		}
	}
	step := "install"
	args := []string{"--working-dir=" + root, "install", "--no-interaction"}
	if len(changes.names) > 0 {
		step = "update"
		args = []string{"--working-dir=" + root, "update", "--with-all-dependencies", "--no-interaction"}
		// A core change moves the Symfony stack every tool shares, so the whole
		// site resolves again; anything else updates only what changed.
		if !slices.ContainsFunc(changes.names, isManagedContribCore) {
			args = append(args, changes.names...)
		}
	}
	restore, err := unlockInstalledSiteDirectory(filepath.Join(root, "web", "sites", "default"))
	if err != nil {
		return err
	}
	return errors.Join(s.contribComposer(root, step, args), restore())
}

func finishContribSync(o drupalContribOptions, s *scaffold, desired contribSyncRecord) error {
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
			// Unchanged means applied before and still declared that way, so an
			// edit a failed update left in composer.json is reapplied too.
			current, declared := site.bucket(dev)[name]
			if old, applied := previous.bucket(dev)[name]; applied && old == constraint && declared && current == constraint {
				continue
			}
			changed[name] = true
			if !declared || current != constraint {
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

// contribManifests holds the site's composer.json and composer.lock bytes
// from before a sync changed them; a lock that did not exist stays absent.
type contribManifests map[string][]byte

func snapshotContribManifests(root string) (contribManifests, error) {
	saved := contribManifests{}
	for _, name := range []string{"composer.json", "composer.lock"} {
		path := filepath.Join(root, name)
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			saved[path] = nil
			continue
		}
		if err != nil {
			return nil, err
		}
		saved[path] = data
	}
	return saved, nil
}

func (saved contribManifests) restore() error {
	var errs []error
	for path, data := range saved {
		if data == nil {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		errs = append(errs, replaceFileAtomically(path, data))
	}
	return errors.Join(errs...)
}

// replaceFileAtomically writes data beside path and renames it into place,
// keeping the current file's mode, so a crash keeps either version whole.
func replaceFileAtomically(path string, data []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp.")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Chmod(mode); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Sync(); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
