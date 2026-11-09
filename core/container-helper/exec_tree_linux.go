package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// PPid in proc stat is the parent TGID. Unlike task/children, stat is
// available without CONFIG_PROC_CHILDREN and does not omit live children
// during concurrent exits. No Wait4 occurs between discovery and signalling.
func execStatParent(data string, expectedPID int) (int, error) {
	left, right := strings.IndexByte(data, '('), strings.LastIndexByte(data, ')')
	if left < 1 || right <= left {
		return 0, errors.New("invalid-proc-stat")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(data[:left]))
	if err != nil || pid != expectedPID {
		return 0, errors.New("invalid-proc-pid")
	}
	fields := strings.Fields(data[right+1:])
	if len(fields) < 2 || len(fields[0]) != 1 {
		return 0, errors.New("invalid-proc-stat")
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil || parent < 0 {
		return 0, errors.New("invalid-proc-parent")
	}
	return parent, nil
}

func execProcNamespaceStatus(data string, selfPID int) error {
	found := false
	for _, line := range strings.Split(data, "\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok || name != "NStgid" {
			continue
		}
		if found {
			return errors.New("ambiguous-proc-namespace")
		}
		found = true
		fields := strings.Fields(value)
		if len(fields) != 1 {
			return errors.New("ancestor-proc-namespace")
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 || pid != selfPID {
			return errors.New("invalid-proc-namespace")
		}
	}
	if !found {
		return errors.New("unsupported-proc-namespace")
	}
	return nil
}

func execDescendants() ([]int, error) {
	return execDescendantsAt("/proc", os.Getpid())
}

func execDescendantsAt(procRoot string, selfPID int) ([]int, error) {
	// NStgid starts at the procfs mount's PID namespace. Multiple values
	// identify an ancestor mount even when numeric self PIDs coincide.
	status, err := os.ReadFile(filepath.Join(procRoot, "self", "status"))
	if err != nil {
		return nil, err
	}
	if err = execProcNamespaceStatus(string(status), selfPID); err != nil {
		return nil, err
	}
	// /proc may belong to an ancestor PID namespace. Prove its self identity
	// before interpreting any numeric PPid as an owned process identifier.
	self, err := os.ReadFile(filepath.Join(procRoot, "self", "stat"))
	if err != nil {
		return nil, err
	}
	if _, err = execStatParent(string(self), selfPID); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, err
	}
	children := make(map[int][]int)
	foundSelf := false
	for _, entry := range entries {
		pid, e := strconv.Atoi(entry.Name())
		if e != nil || pid <= 0 {
			continue
		}
		b, e := os.ReadFile(filepath.Join(procRoot, entry.Name(), "stat"))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		parent, e := execStatParent(string(b), pid)
		if e != nil {
			return nil, e
		}
		if pid == selfPID {
			foundSelf = true
		}
		children[parent] = append(children[parent], pid)
	}
	if !foundSelf {
		return nil, errors.New("proc-unavailable")
	}
	owned := []int{selfPID}
	for i := 0; i < len(owned); i++ {
		owned = append(owned, children[owned[i]]...)
	}
	return owned[1:], nil
}

func execSignalTree(sig syscall.Signal, delivered map[int]syscall.Signal, scan func() ([]int, error)) error {
	children, err := scan()
	if err != nil {
		return err
	}
	current := make(map[int]bool, len(children))
	for _, pid := range children {
		current[pid] = true
	}
	for pid := range delivered {
		if !current[pid] {
			delete(delivered, pid)
		}
	}
	for _, pid := range children {
		if delivered[pid] == sig {
			continue
		}
		if e := syscall.Kill(pid, sig); e != nil && e != syscall.ESRCH {
			return e
		}
		delivered[pid] = sig
	}
	return nil
}

func execStatusCode(status syscall.WaitStatus) int {
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}
