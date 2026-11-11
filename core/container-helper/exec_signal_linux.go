package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const execSignalNotFound = 3

type execSignalTarget struct {
	helper, nonce string
	signal        syscall.Signal
}

func execNonceValid(nonce string) bool {
	decoded, err := hex.DecodeString(nonce)
	return err == nil && len(decoded) == 16 && strings.ToLower(nonce) == nonce
}

func execSignalMatches(cmdline []byte, helper string, nonce string) bool {
	args := bytes.Split(cmdline, []byte{0})
	if len(args) < 7 || len(args[len(args)-1]) != 0 {
		return false
	}
	if string(args[0]) != helper || string(args[1]) != "exec-run" || string(args[2]) != "--nonce" || string(args[3]) != nonce {
		return false
	}
	i := 4
	if string(args[i]) == "--umask" {
		if len(args) < 9 {
			return false
		}
		if _, err := strconv.ParseUint(string(args[i+1]), 8, 9); err != nil || len(args[i+1]) != 4 {
			return false
		}
		i += 2
	}
	return string(args[i]) == "--" && len(args[i+1]) > 0
}

func runExecSignal(helper string, args []string) int {
	if len(args) != 3 || args[0] != "--nonce" || !execNonceValid(args[1]) {
		return 64
	}
	var sig syscall.Signal
	switch args[2] {
	case "INT":
		sig = syscall.SIGINT
	case "TERM":
		sig = syscall.SIGTERM
	default:
		return 64
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil || execProcNamespaceStatus(string(status), os.Getpid()) != nil {
		return 125
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 125
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		// Pin the process before reading its identity. PID reuse must never
		// redirect the eventual signal to a different process.
		fd, _, errno := syscall.Syscall(434, uintptr(pid), 0, 0) // pidfd_open
		if errno == syscall.ESRCH {
			continue
		}
		if errno != 0 {
			return 125
		}
		code := execSignalCandidate(int(fd), filepath.Join("/proc", entry.Name()), execSignalTarget{helper, args[1], sig})
		closeErr := syscall.Close(int(fd))
		if closeErr != nil || code == 125 {
			return 125
		}
		if code == 0 {
			return 0
		}
	}
	return execSignalNotFound
}

func execSignalCandidate(fd int, root string, target execSignalTarget) int {
	var stat syscall.Stat_t
	if err := syscall.Stat(root, &stat); err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return execSignalNotFound
		}
		return 125
	}
	if os.Geteuid() != 0 && stat.Uid != uint32(os.Geteuid()) {
		return execSignalNotFound
	}
	cmdline, err := os.ReadFile(filepath.Join(root, "cmdline"))
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
		return execSignalNotFound
	}
	if err != nil {
		return 125
	}
	if !execSignalMatches(cmdline, target.helper, target.nonce) {
		return execSignalNotFound
	}
	_, _, errno := syscall.Syscall6(424, uintptr(fd), uintptr(target.signal), 0, 0, 0, 0) // pidfd_send_signal
	if errno == syscall.ESRCH {
		return execSignalNotFound
	}
	if errno != 0 {
		return 125
	}
	return 0
}
