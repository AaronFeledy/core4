package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func (s *scaffold) releaseLock() {
	if s.lock == nil {
		return
	}
	s.lock.release()
	s.lock = nil
}

type scaffoldLock struct {
	path     string
	identity fileIdentity
}

func acquireScaffoldLock(appRoot string) (*scaffoldLock, error) {
	path := filepath.Join(appRoot, scaffoldLockName)
	cleanScaffoldLockTemps(appRoot)
	for attempt := 0; attempt < 8; attempt++ {
		err := publishScaffoldLock(path)
		if err == nil {
			info, statErr := os.Lstat(path)
			if statErr != nil {
				return nil, statErr
			}
			return &scaffoldLock{path: path, identity: identityOf(info)}, nil
		}
		if !errors.Is(err, syscall.EEXIST) {
			return nil, err
		}
		info, statErr := os.Lstat(path)
		if errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return nil, statErr
		}
		identity := identityOf(info)
		pid, ownerKnown := readScaffoldLockPID(path)
		if ownerKnown && processAlive(pid) {
			return nil, fmt.Errorf("Another Lando scaffold is already running for %s.", appRoot)
		}
		current, statErr := os.Lstat(path)
		if errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return nil, statErr
		}
		if identityOf(current) != identity {
			// Someone else recovered or replaced it between our read and
			// removal; retry instead of deleting their lock.
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			return nil, err
		}
		syncDir(appRoot)
	}
	return nil, fmt.Errorf("Unable to acquire the Lando scaffold lock for %s.", appRoot)
}

func publishScaffoldLock(path string) error {
	temporary := fmt.Sprintf("%s.tmp.%d.%d", path, os.Getpid(), time.Now().UnixNano())
	if err := os.Mkdir(temporary, 0o700); err != nil {
		return err
	}
	owner := filepath.Join(temporary, "pid")
	file, err := os.OpenFile(owner, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		_ = os.RemoveAll(temporary)
		return err
	}
	if _, err := file.WriteString(strconv.Itoa(os.Getpid()) + "\n"); err != nil {
		_ = file.Close()
		_ = os.RemoveAll(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.RemoveAll(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.RemoveAll(temporary)
		return err
	}
	syncDir(temporary)
	if err := renameNoReplace(temporary, path); err != nil {
		_ = os.RemoveAll(temporary)
		return err
	}
	syncDir(filepath.Dir(path))
	return nil
}

func cleanScaffoldLockTemps(appRoot string) {
	entries, err := os.ReadDir(appRoot)
	if err != nil {
		return
	}
	prefix := scaffoldLockName + ".tmp."
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		rest := strings.TrimPrefix(entry.Name(), prefix)
		pidText, _, ok := strings.Cut(rest, ".")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidText)
		if err != nil || processAlive(pid) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(appRoot, entry.Name()))
	}
}

func readScaffoldLockPID(path string) (int, bool) {
	data, err := os.ReadFile(filepath.Join(path, "pid"))
	if err != nil {
		return 0, false
	}
	text := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(text)
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

func (l *scaffoldLock) release() {
	info, err := os.Lstat(l.path)
	if err != nil || identityOf(info) != l.identity {
		return
	}
	pid, ok := readScaffoldLockPID(l.path)
	if !ok || pid != os.Getpid() {
		return
	}
	if err := os.RemoveAll(l.path); err != nil {
		return
	}
	syncDir(filepath.Dir(l.path))
}
