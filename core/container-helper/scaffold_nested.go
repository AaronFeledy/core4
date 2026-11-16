package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func (s *scaffold) promoteNested(manifest *scaffoldManifest, entry *scaffoldEntry) error {
	target := filepath.Join(s.appRoot, entry.Name)
	partial := filepath.Join(target, ".lando-partial")
	owner := filepath.Join(partial, ".lando-owned")
	if entry.State == "nested-pending" {
		entry.State = "nested-incomplete"
		entry.Token = scaffoldToken()
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("nested-state")
	}
	if entry.State == "nested-incomplete" {
		if err := s.resetNestedPartial(target, partial, owner, entry.Token); err != nil {
			return err
		}
		if err := s.copyNestedGeneration(entry); err != nil {
			return err
		}
		if err := s.recordNestedChildren(manifest, entry, partial, owner); err != nil {
			return err
		}
	}
	for index := range entry.Children {
		child := &entry.Children[index]
		if err := s.promoteNestedChild(target, partial, child); err != nil {
			return err
		}
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
	}
	if pathExists(owner) {
		data, err := os.ReadFile(owner)
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(data)) != entry.Token {
			return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, partial)
		}
		if err := os.Remove(owner); err != nil {
			return err
		}
	}
	if pathExists(partial) {
		if err := os.Remove(partial); err != nil {
			return fmt.Errorf("%s scaffold nested partial path is not empty: %s", s.label, partial)
		}
	}
	entry.State = "complete"
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	s.point("nested-complete")
	return nil
}

// resetNestedPartial validates that the target still holds only this run's
// partial, then removes the partial so the copy can start from the staged
// generation again. An empty target is accepted untouched.
func (s *scaffold) resetNestedPartial(target string, partial string, owner string, token string) error {
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != filepath.Base(partial) {
			return s.ambiguousTarget(target)
		}
	}
	if !pathExists(partial) {
		return nil
	}
	info, err := os.Lstat(partial)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s scaffold nested partial path is not safely recoverable: %s", s.label, partial)
	}
	data, err := os.ReadFile(owner)
	if err != nil {
		return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, partial)
	}
	if strings.TrimSpace(string(data)) != token {
		return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, partial)
	}
	return os.RemoveAll(partial)
}

func (s *scaffold) copyNestedGeneration(entry *scaffoldEntry) error {
	staged := filepath.Join(s.stageDir, entry.Name)
	info, err := os.Lstat(staged)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s scaffold staged entry is not a directory: %s", s.label, staged)
	}
	partial := filepath.Join(s.appRoot, entry.Name, ".lando-partial")
	if err := os.Mkdir(partial, 0o755); err != nil {
		return err
	}
	owner := filepath.Join(partial, ".lando-owned")
	file, err := os.OpenFile(owner, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(entry.Token + "\n"); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	s.point("nested-partial")

	children, err := os.ReadDir(staged)
	if err != nil {
		return err
	}
	for _, child := range children {
		if err := copyScaffoldTree(filepath.Join(staged, child.Name()), filepath.Join(partial, child.Name())); err != nil {
			return err
		}
	}
	syncDir(partial)
	s.point("nested-copied")
	return nil
}

func (s *scaffold) recordNestedChildren(
	manifest *scaffoldManifest,
	entry *scaffoldEntry,
	partial string,
	owner string,
) error {
	children, err := os.ReadDir(partial)
	if err != nil {
		return err
	}
	recorded := make([]scaffoldChild, 0, len(children))
	for _, child := range children {
		if child.Name() == filepath.Base(owner) {
			continue
		}
		info, err := os.Lstat(filepath.Join(partial, child.Name()))
		if err != nil {
			return err
		}
		identity := identityOf(info)
		recorded = append(recorded, scaffoldChild{
			Name:     child.Name(),
			State:    "ready",
			Identity: &identity,
		})
	}
	entry.Children = recorded
	entry.State = "nested-ready"
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	s.point("nested-ready")
	return nil
}

func (s *scaffold) promoteNestedChild(target string, partial string, child *scaffoldChild) error {
	stagedChild := filepath.Join(partial, child.Name)
	promotedChild := filepath.Join(target, child.Name)
	stagedInfo, stagedErr := os.Lstat(stagedChild)
	promotedInfo, promotedErr := os.Lstat(promotedChild)
	switch {
	case promotedErr == nil:
		if child.Identity == nil || !sameIdentity(*child.Identity, identityOf(promotedInfo)) {
			return s.ambiguousTarget(promotedChild)
		}
		child.State = "complete"
		return nil
	case !errors.Is(promotedErr, fs.ErrNotExist):
		return promotedErr
	}
	if stagedErr != nil {
		return fmt.Errorf("%s scaffold nested entry is missing: %s", s.label, stagedChild)
	}
	if child.Identity == nil || !sameIdentity(*child.Identity, identityOf(stagedInfo)) {
		return fmt.Errorf("%s scaffold nested entry changed after its manifest: %s", s.label, stagedChild)
	}
	if err := renameNoReplace(stagedChild, promotedChild); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			return s.ambiguousTarget(promotedChild)
		}
		return err
	}
	child.State = "complete"
	s.point("nested-child")
	return nil
}

func (s *scaffold) ambiguousTarget(path string) error {
	return fmt.Errorf(
		"%s scaffold found an ambiguous target during promotion: %s",
		s.label,
		path,
	)
}
