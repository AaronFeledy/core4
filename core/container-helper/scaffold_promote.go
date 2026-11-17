package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

func (s *scaffold) classify(manifest *scaffoldManifest) error {
	entries, err := os.ReadDir(s.stageDir)
	if err != nil {
		return err
	}
	classified := make([]scaffoldEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if err := s.validateStagedName(name); err != nil {
			return err
		}
		info, err := os.Lstat(filepath.Join(s.stageDir, name))
		if err != nil {
			return err
		}
		identity := identityOf(info)
		target := filepath.Join(s.appRoot, name)
		targetInfo, err := os.Lstat(target)
		switch {
		case err == nil:
			if targetInfo.IsDir() && targetInfo.Mode()&os.ModeSymlink == 0 && dirIsEmpty(target) {
				if !info.IsDir() {
					return fmt.Errorf(
						"%s scaffold cannot fill the empty directory %s with the staged file %s.",
						s.label,
						target,
						name,
					)
				}
				classified = append(classified, scaffoldEntry{Name: name, State: "nested-pending"})
			} else {
				classified = append(classified, scaffoldEntry{Name: name, State: "preexisting"})
			}
		case errors.Is(err, fs.ErrNotExist):
			classified = append(classified, scaffoldEntry{
				Name:     name,
				State:    "pending",
				Identity: &identity,
			})
		default:
			return err
		}
	}
	manifest.Entries = classified
	manifest.Phase = "staged"
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	s.point("classified")
	return nil
}

// reportKeptPaths tells the user, once per promotion, which existing paths
// were kept instead of filled with the project's version. Lando's own files
// are engine state, not project content, so they are never reported.
func (s *scaffold) reportKeptPaths(manifest *scaffoldManifest) {
	for _, entry := range manifest.Entries {
		if entry.State != "preexisting" || s.isLandoOwnedName(entry.Name) {
			continue
		}
		fmt.Fprintf(
			s.streams.stderr,
			"%s kept existing path %q; the project's version was not installed.\n",
			s.label,
			entry.Name,
		)
	}
}

// isLandoOwnedName reports whether a top-level path belongs to the engine's
// own bookkeeping rather than to the scaffolded project.
func (s *scaffold) isLandoOwnedName(name string) bool {
	if name == ".lando.yml" || name == scaffoldStageRoot || name == scaffoldLockName {
		return true
	}
	if name == filepath.Base(s.manifestPath) {
		return true
	}
	return s.markerPath != "" && name == filepath.Base(s.markerPath)
}

func (s *scaffold) promote(manifest *scaffoldManifest) error {
	for index := range manifest.Entries {
		entry := &manifest.Entries[index]
		switch entry.State {
		case "preexisting", "complete":
			continue
		case "pending", "ready":
			if err := s.promoteSibling(manifest, entry); err != nil {
				return err
			}
		case "nested-pending", "nested-incomplete", "nested-ready":
			if err := s.promoteNested(manifest, entry); err != nil {
				return err
			}
		default:
			return fmt.Errorf("Invalid %s scaffold manifest state: %s", s.label, entry.State)
		}
	}
	return nil
}

// promoteSibling moves a staged top-level path into a target that did not
// exist at the manifest snapshot. renameat2(RENAME_NOREPLACE) makes the move
// atomic and refuses a path another writer created after the snapshot.
func (s *scaffold) promoteSibling(manifest *scaffoldManifest, entry *scaffoldEntry) error {
	staged := filepath.Join(s.stageDir, entry.Name)
	target := filepath.Join(s.appRoot, entry.Name)
	if entry.State == "pending" {
		entry.State = "ready"
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("sibling-ready")
	}
	stagedInfo, stagedErr := os.Lstat(staged)
	targetInfo, targetErr := os.Lstat(target)
	switch {
	case stagedErr == nil:
		if entry.Identity == nil || *entry.Identity != identityOf(stagedInfo) {
			return fmt.Errorf("%s scaffold staged entry changed after its manifest: %s", s.label, staged)
		}
		if targetErr == nil {
			return s.ambiguousTarget(target)
		}
		if !errors.Is(targetErr, fs.ErrNotExist) {
			return targetErr
		}
		if err := renameNoReplace(staged, target); err != nil {
			if errors.Is(err, syscall.EEXIST) {
				return s.ambiguousTarget(target)
			}
			return err
		}
		s.point("sibling-promoted")
	case errors.Is(stagedErr, fs.ErrNotExist):
		if targetErr != nil {
			return fmt.Errorf(
				"%s scaffold lost both its staged entry and target: %s",
				s.label,
				entry.Name,
			)
		}
		if entry.Identity == nil || *entry.Identity != identityOf(targetInfo) {
			return s.ambiguousTarget(target)
		}
	default:
		return stagedErr
	}
	entry.State = "complete"
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	s.point("entry-complete")
	return nil
}
