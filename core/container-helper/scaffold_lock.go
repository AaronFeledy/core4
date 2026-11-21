package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type scaffoldLock struct {
	file *os.File
	info os.FileInfo
}

func acquireScaffoldLock(appRoot string) (*scaffoldLock, error) {
	return acquireScaffoldLockWithFlock(appRoot, syscall.Flock)
}

func acquireScaffoldLockWithFlock(appRoot string, flock func(int, int) error) (*scaffoldLock, error) {
	path := filepath.Join(appRoot, scaffoldLockName)
	for attempt := 0; attempt < 8; attempt++ {
		lock, err := tryScaffoldLock(path, flock)
		switch {
		case errors.Is(err, syscall.EWOULDBLOCK), errors.Is(err, syscall.EAGAIN):
			return nil, fmt.Errorf("Another Lando scaffold is already running for %s.", appRoot)
		case err != nil:
			return nil, err
		case lock != nil:
			return lock, nil
		}
	}
	return nil, fmt.Errorf("Unable to acquire the Lando scaffold lock for %s.", appRoot)
}

// A nil lock with no error means the path changed while this fd was open.
func tryScaffoldLock(path string, flock func(int, int) error) (lock *scaffoldLock, err error) {
	var fd int
	for {
		fd, err = syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		// Some special files (e.g. sockets) fail open before we can fstat.
		info, statErr := os.Lstat(path)
		if err == syscall.ELOOP || err == syscall.EISDIR || (statErr == nil && !info.Mode().IsRegular()) {
			return nil, unsafeScaffoldLockPath(path)
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(fd), path)
	defer func() {
		if lock == nil {
			_ = file.Close()
		}
	}()
	for {
		err = flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		return nil, &os.PathError{Op: "flock", Path: path, Err: err}
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, unsafeScaffoldLockPath(path)
	}
	current, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// A previous owner may have unlinked this inode before unlocking it.
	if !os.SameFile(info, current) {
		return nil, nil
	}
	host, err := os.Hostname()
	if err != nil {
		host = "unknown"
	}
	if err := file.Truncate(0); err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(file, "pid=%d host=%s\n", os.Getpid(), host); err != nil {
		return nil, err
	}
	return &scaffoldLock{file: file, info: info}, nil
}

func unsafeScaffoldLockPath(path string) error {
	return fmt.Errorf("Unsafe Lando scaffold lock path %s: expected a regular file. Make sure no scaffold is running, then remove it.", path)
}

func (l *scaffoldLock) release() {
	defer l.file.Close()
	path := l.file.Name()
	if current, err := os.Lstat(path); err == nil && os.SameFile(l.info, current) {
		_ = syscall.Unlink(path)
	}
	for syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN) == syscall.EINTR {
	}
}
