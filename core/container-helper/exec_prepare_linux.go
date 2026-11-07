package main

import (
	"errors"
	"os"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

func runExecPrepare(args []string, streams helperIO) int {
	if len(args) != 4 || !validExecSession(args[0], args[1]) || os.Geteuid() != 0 {
		return execEmit(streams.stdout, execFailure("invalid-session"))
	}
	if execVerifyBinary(args[3]) != nil {
		return execEmit(streams.stdout, execFailure("helper-verification-failed"))
	}
	name, _, _ := strings.Cut(args[2], ":")
	uid := 0
	if name != "" {
		var err error
		uid, err = strconv.Atoi(name)
		if err != nil {
			account, lookupErr := user.Lookup(name)
			if lookupErr != nil {
				return execEmit(streams.stdout, execFailure("session-user-unavailable"))
			}
			uid, err = strconv.Atoi(account.Uid)
		}
		if err != nil || uid < 0 || uint64(uid) >= 1<<32-1 {
			return execEmit(streams.stdout, execFailure("session-user-unavailable"))
		}
	}
	if prepareExecDirectory(args[0], uid) != nil {
		return execEmit(streams.stdout, execFailure("session-provision-failed"))
	}
	return execEmit(streams.stdout, execReply{OK: true, State: "initialized"})
}

func prepareExecDirectory(dir string, uid int) (err error) {
	if err = os.Mkdir(dir, 0700); err != nil {
		return err
	}
	prepared := false
	defer func() {
		if !prepared {
			err = errors.Join(err, os.RemoveAll(dir))
		}
	}()
	// Open the newly created directory without following a concurrent replacement.
	fd, err := syscall.Open(dir, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	lock, err := execLock(dir)
	if err != nil {
		return err
	}
	defer execUnlock(lock)
	if err = execMark(dir, "initialized"); err != nil {
		return err
	}
	for _, name := range []string{"lock", "initialized"} {
		if err = os.Chown(dir+"/"+name, uid, -1); err != nil {
			return err
		}
	}
	if err = syscall.Fchown(fd, uid, -1); err != nil {
		return err
	}
	prepared = true
	return nil
}
