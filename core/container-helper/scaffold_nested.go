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

// nestedTarget names the engine-owned directories inside an empty-directory
// target. The temporary name is derived from the run token recorded in the
// manifest, so a retry recognizes and removes a directory left before it was
// published without confusing it with the user's own content.
type nestedTarget struct {
	target         string
	partial        string
	owner          string
	temporary      string
	temporaryOwner string
	token          string
}

func nestedTargetFor(appRoot string, entry *scaffoldEntry) nestedTarget {
	target := filepath.Join(appRoot, entry.Name)
	partial := filepath.Join(target, scaffoldNestedPartial)
	temporary := filepath.Join(target, scaffoldNestedPartial+"."+entry.Token)
	return nestedTarget{
		target:         target,
		partial:        partial,
		owner:          filepath.Join(partial, scaffoldNestedOwner),
		temporary:      temporary,
		temporaryOwner: filepath.Join(temporary, scaffoldNestedOwner),
		token:          entry.Token,
	}
}

// promoteNested fills an empty directory target in place. A mounted vendor,
// node_modules, or working-directory shadow cannot be replaced by a rename, so
// the staged tree is copied into a private partial inside the target and each
// child is then renamed into the target with RENAME_NOREPLACE. The partial is
// built under a temporary name that already carries its ownership proof and is
// then renamed into place, so a kill leaves nothing, a removable temp, or a
// fully owned partial, never an unowned partial a retry would reject.
func (s *scaffold) promoteNested(manifest *scaffoldManifest, entry *scaffoldEntry) error {
	if entry.State == "nested-pending" {
		entry.State = "nested-incomplete"
		entry.Token = scaffoldToken()
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("nested-state")
	}
	paths := nestedTargetFor(s.appRoot, entry)
	if entry.State == "nested-incomplete" {
		if err := s.resetNestedPartial(paths); err != nil {
			return err
		}
		if err := s.copyNestedGeneration(entry, paths); err != nil {
			return err
		}
		if err := s.recordNestedChildren(manifest, entry, paths); err != nil {
			return err
		}
	}
	for index := range entry.Children {
		child := &entry.Children[index]
		if err := s.promoteNestedChild(paths.target, paths.partial, child); err != nil {
			return err
		}
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
	}
	if pathExists(paths.owner) {
		data, err := os.ReadFile(paths.owner)
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(data)) != entry.Token {
			return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, paths.partial)
		}
		if err := os.Remove(paths.owner); err != nil {
			return err
		}
	}
	if pathExists(paths.partial) {
		if err := os.Remove(paths.partial); err != nil {
			return fmt.Errorf("%s scaffold nested partial path is not empty: %s", s.label, paths.partial)
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
// publication directories, then removes them so the copy can start from the
// staged generation again. An empty target is accepted untouched.
func (s *scaffold) resetNestedPartial(paths nestedTarget) error {
	entries, err := os.ReadDir(paths.target)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != filepath.Base(paths.partial) &&
			entry.Name() != filepath.Base(paths.temporary) {
			return s.ambiguousTarget(paths.target)
		}
	}
	if err := s.removeNestedPartial(paths); err != nil {
		return err
	}
	return s.removeNestedTemporary(paths)
}

// removeNestedPartial removes a published partial this run owns. Publication
// happens only after the ownership file is durable; an empty partial without
// one is the crash window of the non-atomic publication this engine replaced,
// and is safe to drop so a retry can resume.
func (s *scaffold) removeNestedPartial(paths nestedTarget) error {
	info, err := os.Lstat(paths.partial)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s scaffold nested partial path is not safely recoverable: %s", s.label, paths.partial)
	}
	data, err := os.ReadFile(paths.owner)
	if errors.Is(err, fs.ErrNotExist) {
		if !dirIsEmpty(paths.partial) {
			return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, paths.partial)
		}
		return os.Remove(paths.partial)
	}
	if err != nil || strings.TrimSpace(string(data)) != paths.token {
		return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, paths.partial)
	}
	return os.RemoveAll(paths.partial)
}

// removeNestedTemporary removes an unpublished partial. The directory exists
// before its ownership file, so an empty directory is the only state that may
// legitimately lack one.
func (s *scaffold) removeNestedTemporary(paths nestedTarget) error {
	info, err := os.Lstat(paths.temporary)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s scaffold nested partial path is not safely recoverable: %s", s.label, paths.temporary)
	}
	data, err := os.ReadFile(paths.temporaryOwner)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if !dirIsEmpty(paths.temporary) {
			return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, paths.temporary)
		}
	case err != nil || strings.TrimSpace(string(data)) != paths.token:
		return fmt.Errorf("%s scaffold nested partial ownership is invalid: %s", s.label, paths.temporary)
	}
	return os.RemoveAll(paths.temporary)
}

func (s *scaffold) copyNestedGeneration(entry *scaffoldEntry, paths nestedTarget) error {
	staged := filepath.Join(s.stageDir, entry.Name)
	info, err := os.Lstat(staged)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s scaffold staged entry is not a directory: %s", s.label, staged)
	}
	if err := os.Mkdir(paths.temporary, 0o755); err != nil {
		return err
	}
	s.point("nested-temp")
	if err := writeNestedOwnership(paths.temporaryOwner, paths.token); err != nil {
		return err
	}
	s.point("nested-temp-owned")

	children, err := os.ReadDir(staged)
	if err != nil {
		return err
	}
	for _, child := range children {
		if err := copyScaffoldTree(filepath.Join(staged, child.Name()), filepath.Join(paths.temporary, child.Name())); err != nil {
			return err
		}
	}
	syncDir(paths.temporary)
	s.point("nested-copied")
	if err := renameNoReplace(paths.temporary, paths.partial); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			return s.ambiguousTarget(paths.partial)
		}
		return err
	}
	syncDir(paths.target)
	s.point("nested-partial")
	return nil
}

// writeNestedOwnership makes the partial's ownership proof durable before the
// directory can be published.
func writeNestedOwnership(path string, token string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(token + "\n"); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func (s *scaffold) recordNestedChildren(
	manifest *scaffoldManifest,
	entry *scaffoldEntry,
	paths nestedTarget,
) error {
	children, err := os.ReadDir(paths.partial)
	if err != nil {
		return err
	}
	recorded := make([]scaffoldChild, 0, len(children))
	for _, child := range children {
		if child.Name() == filepath.Base(paths.owner) {
			continue
		}
		info, err := os.Lstat(filepath.Join(paths.partial, child.Name()))
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
		if child.Identity == nil || *child.Identity != identityOf(promotedInfo) {
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
	if child.Identity == nil || *child.Identity != identityOf(stagedInfo) {
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
