package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The control socket is separate from the payload descriptors. Nothing written by
// the workload is interpreted as protocol data.
type execReply struct {
	OK       bool   `json:"ok"`
	State    string `json:"state,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Joined   bool   `json:"joined,omitempty"`
	Error    string `json:"error,omitempty"`
}
type execRequest struct {
	Op     string `json:"op"`
	Signal string `json:"signal,omitempty"`
}
type execCall struct {
	request      execRequest
	reply        chan execReply
	acknowledged chan struct{}
}

func execFailure(code string) execReply { return execReply{Error: code} }
func execEmit(w io.Writer, reply execReply) int {
	if json.NewEncoder(w).Encode(reply) != nil {
		return 1
	}
	if !reply.OK {
		return 1
	}
	return 0
}
func validExecSession(dir, nonce string) bool {
	if len(nonce) != 32 {
		return false
	}
	if _, err := hex.DecodeString(nonce); err != nil {
		return false
	}
	return dir == "/tmp/lando-exec-session-"+nonce
}
func execPrivateDirectory(dir string) error {
	if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	return execCheckPrivateDirectory(dir)
}
func execCheckPrivateDirectory(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("unsafe-directory")
	}
	return nil
}
func execLock(dir string) (*os.File, error) {
	fd, err := syscall.Open(filepath.Join(dir, "lock"), syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "lock")
	if err = syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func execUnlock(f *os.File) { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }
func execExists(dir, name string) bool {
	_, err := os.Lstat(filepath.Join(dir, name))
	return err == nil
}
func execMark(dir, name string) error {
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return f.Close()
}
func execSave(dir string, r execReply) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "result.tmp")
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "result"))
}
func execLoad(dir string) (execReply, bool) {
	var r execReply
	b, err := os.ReadFile(filepath.Join(dir, "result"))
	if err != nil || len(b) > 4096 || json.Unmarshal(b, &r) != nil {
		return r, false
	}
	return r, true
}
func execVerifyBinary(digest string) error {
	if len(digest) != 64 {
		return errors.New("digest")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return err
	}
	path, err := os.Executable()
	if err != nil {
		return err
	}
	// os.Executable reads /proc/self/exe; reject a renamed/deleted or symlinked cache.
	for _, p := range []string{filepath.Dir(path), path} {
		info, e := os.Lstat(p)
		if e != nil {
			return e
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0755 {
			return errors.New("cache")
		}
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != digest {
		return errors.New("digest")
	}
	return nil
}
func runExecInit(args []string, streams helperIO) int {
	if len(args) != 3 || !validExecSession(args[0], args[1]) {
		return execEmit(streams.stdout, execFailure("invalid-session"))
	}
	if execVerifyBinary(args[2]) != nil {
		return execEmit(streams.stdout, execFailure("helper-verification-failed"))
	}
	if execPrivateDirectory(args[0]) != nil {
		return execEmit(streams.stdout, execFailure("unsafe-session"))
	}
	lock, err := execLock(args[0])
	if err != nil {
		return execEmit(streams.stdout, execFailure("session-lock-failed"))
	}
	defer execUnlock(lock)
	if execMark(args[0], "initialized") != nil {
		return execEmit(streams.stdout, execFailure("session-write-failed"))
	}
	return execEmit(streams.stdout, execReply{OK: true, State: "initialized"})
}
func runExecControl(args []string, streams helperIO) int {
	if len(args) < 3 || len(args) > 4 || !validExecSession(args[0], args[1]) {
		return execEmit(streams.stdout, execFailure("invalid-session"))
	}
	dir, op := args[0], args[2]
	switch op {
	case "ready", "launch", "cancel", "status", "collect":
	default:
		return execEmit(streams.stdout, execFailure("invalid-operation"))
	}
	signal := "SIGTERM"
	if len(args) == 4 {
		signal = args[3]
		if op != "cancel" || (signal != "SIGTERM" && signal != "SIGINT") {
			return execEmit(streams.stdout, execFailure("invalid-signal"))
		}
	}
	if op == "cancel" {
		if execPrivateDirectory(dir) != nil {
			return execEmit(streams.stdout, execFailure("unsafe-session"))
		}
		lock, err := execLock(dir)
		if err != nil {
			return execEmit(streams.stdout, execFailure("session-lock-failed"))
		}
		if !execExists(dir, "cancelled") && signal == "SIGINT" {
			err = execMark(dir, "cancel-sigint")
		}
		if err == nil {
			err = execMark(dir, "cancelled")
		}
		launched := execExists(dir, "launched")
		execUnlock(lock)
		if err != nil {
			return execEmit(streams.stdout, execFailure("session-write-failed"))
		}
		if !launched {
			return execEmit(streams.stdout, execReply{OK: true, State: "cancelled", Joined: true})
		}
	}
	if execCheckPrivateDirectory(dir) != nil {
		return execEmit(streams.stdout, execFailure("unsafe-session"))
	}
	conn, err := net.DialTimeout("unix", filepath.Join(dir, "control"), time.Second)
	if err != nil {
		if r, ok := execLoad(dir); ok {
			return execEmit(streams.stdout, r)
		}
		return execEmit(streams.stdout, execFailure("control-unavailable"))
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(6 * time.Second))
	if json.NewEncoder(conn).Encode(execRequest{op, signal}) != nil {
		return execEmit(streams.stdout, execFailure("control-write-failed"))
	}
	var r execReply
	if json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&r) != nil {
		return execEmit(streams.stdout, execFailure("control-read-failed"))
	}
	return execEmit(streams.stdout, r)
}

// Only this loop calls Wait4. Direct children cannot have their PIDs recycled
// until this owner reaps them. Never retain a discovered PID across a reap.
func execDirectChildren() ([]int, error) { return execDirectChildrenStat() }

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
func execDirectChildrenStat() ([]int, error) {
	return execDirectChildrenAt("/proc", os.Getpid())
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

func execDirectChildrenAt(procRoot string, selfPID int) ([]int, error) {
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
	var children []int
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
		if parent == selfPID {
			children = append(children, pid)
		}
	}
	if !foundSelf {
		return nil, errors.New("proc-unavailable")
	}
	return children, nil
}
func execSignalTree(main int, group bool, sig syscall.Signal, delivered map[int]syscall.Signal, groupDelivered *syscall.Signal, scan func() ([]int, error)) error {
	children, err := scan()
	if err != nil {
		return err
	}
	if group && main > 0 && *groupDelivered != sig {
		if e := syscall.Kill(-main, sig); e != nil && e != syscall.ESRCH {
			return e
		}
		*groupDelivered = sig
	}
	for _, pid := range children {
		if delivered[pid] == sig || (group && pid == main) {
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
func execStart(argv []string, streams helperIO) (*os.Process, error) {
	files := make([]*os.File, 3)
	for i, v := range []interface{}{streams.stdin, streams.stdout, streams.stderr} {
		f, ok := v.(*os.File)
		if !ok {
			return nil, errors.New("payload-descriptor")
		}
		files[i] = f
	}
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, err
	}
	return os.StartProcess(path, argv, &os.ProcAttr{Env: os.Environ(), Files: files, Sys: &syscall.SysProcAttr{Setsid: true}})
}
func runExecSupervisor(args []string, streams helperIO) int {
	return runExecSupervisorWithScan(args, streams, execDirectChildren)
}

func runExecSupervisorWithScan(args []string, streams helperIO, scan func() ([]int, error)) int {
	if len(args) < 4 || args[2] != "--" || !validExecSession(args[0], args[1]) {
		return 125
	}
	dir := args[0]
	if execPrivateDirectory(dir) != nil {
		return 125
	}
	lock, err := execLock(dir)
	if err != nil {
		return 125
	}
	if !execExists(dir, "initialized") {
		execUnlock(lock)
		return 125
	}
	if execExists(dir, "cancelled") {
		execSave(dir, execReply{OK: true, State: "cancelled", Joined: true})
		execUnlock(lock)
		return 0
	}
	if execExists(dir, "supervisor") {
		execUnlock(lock)
		return 125
	}
	if execMark(dir, "supervisor") != nil {
		execUnlock(lock)
		return 125
	}
	// PR_SET_CHILD_SUBREAPER: adopted double-fork/setsid children remain ours.
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0)
	if errno != 0 {
		execSave(dir, execFailure("subreaper-failed"))
		execUnlock(lock)
		return 125
	}
	if _, scanErr := scan(); scanErr != nil {
		execSave(dir, execFailure("proc-unavailable"))
		execUnlock(lock)
		return 125
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "control"))
	execUnlock(lock)
	if err != nil {
		execSave(dir, execFailure("control-listen-failed"))
		return 125
	}
	defer listener.Close()
	calls := make(chan execCall)
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(7 * time.Second))
				var req execRequest
				if json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&req) != nil {
					return
				}
				call := execCall{req, make(chan execReply, 1), make(chan struct{})}
				select {
				case calls <- call:
				case <-done:
					return
				}
				select {
				case r := <-call.reply:
					json.NewEncoder(conn).Encode(r)
					close(call.acknowledged)
				case <-done:
					return
				}
			}()
		}
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	state := execReply{OK: true, State: "ready"}
	lease := time.Now().Add(10 * time.Second)
	launchDeadline := lease
	delivered := make(map[int]syscall.Signal)
	var groupDelivered syscall.Signal
	var mainPID int
	var process *os.Process
	group := false
	started := false
	mainReaped := false
	joined := false
	var code int
	cancelling := false
	var cancelAt time.Time
	var cancelSignal syscall.Signal = syscall.SIGTERM
	var pending []chan execReply
	failure := ""
	beginCancel := func(sig syscall.Signal) {
		if !cancelling {
			cancelling = true
			cancelAt = time.Now()
			cancelSignal = sig
		}
	}
	complete := func() {
		if failure != "" {
			state = execFailure(failure)
		} else if started {
			state = execReply{OK: true, State: "finished", ExitCode: &code, Joined: true}
		} else {
			state = execReply{OK: true, State: "cancelled", Joined: true}
		}
		if execSave(dir, state) != nil {
			state = execFailure("session-write-failed")
		}
		for _, ch := range pending {
			ch <- state
		}
		pending = nil
	}
	for {
		select {
		case call := <-calls:
			switch call.request.Op {
			case "ready", "status":
				lease = time.Now().Add(10 * time.Second)
				call.reply <- state
			case "launch":
				if started || joined {
					call.reply <- state
					break
				}
				lock, e := execLock(dir)
				if e != nil {
					call.reply <- execFailure("session-lock-failed")
					break
				}
				if cancelling || execExists(dir, "cancelled") {
					beginCancel(syscall.SIGTERM)
					execUnlock(lock)
					call.reply <- execReply{OK: true, State: "cancelled", Joined: true}
					break
				}
				if time.Now().After(launchDeadline) {
					execUnlock(lock)
					beginCancel(syscall.SIGTERM)
					call.reply <- execFailure("launch-expired")
					break
				}
				e = execMark(dir, "launched")
				if e == nil {
					process, e = execStart(args[3:], streams)
				}
				execUnlock(lock)
				if e != nil {
					failure = "launch-failed"
					joined = true
					complete()
					call.reply <- state
					break
				}
				mainPID = process.Pid
				group = true
				started = true
				state = execReply{OK: true, State: "running"}
				lease = time.Now().Add(10 * time.Second)
				call.reply <- state
			case "cancel":
				if joined {
					call.reply <- state
					break
				}
				sig := syscall.SIGTERM
				if call.request.Signal == "SIGINT" {
					sig = syscall.SIGINT
				}
				beginCancel(sig)
				pending = append(pending, call.reply)
			case "collect":
				if !joined {
					call.reply <- execFailure("not-finished")
					break
				}
				// Wait for the serving goroutine to finish the acknowledgement write.
				call.reply <- state
				listener.Close()
				if process != nil {
					process.Release()
				}
				select {
				case <-call.acknowledged:
				case <-time.After(time.Second):
					return 125
				}
				if !state.OK {
					return 125
				}
				if started {
					return code
				}
				return 0
			default:
				call.reply <- execFailure("invalid-operation")
			}
		case now := <-ticker.C:
			if !joined && (now.After(lease) || (!started && now.After(launchDeadline)) || execExists(dir, "cancelled")) {
				sig := syscall.SIGTERM
				if execExists(dir, "cancel-sigint") {
					sig = syscall.SIGINT
				}
				beginCancel(sig)
			}
			if !joined && cancelling {
				sig := cancelSignal
				if now.Sub(cancelAt) >= 500*time.Millisecond {
					sig = syscall.SIGKILL
				}
				// Discovery and signal happen before any reap in this round.
				if e := execSignalTree(mainPID, group, sig, delivered, &groupDelivered, scan); e != nil {
					failure = "signal-failed"
				}
			}
			if !joined && (started || cancelling) {
				for {
					var status syscall.WaitStatus
					pid, e := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
					if e == syscall.EINTR {
						continue
					}
					if e == syscall.ECHILD {
						if started && !mainReaped {
							failure = "main-status-missing"
						}
						joined = true
						complete()
						break
					}
					if e != nil {
						failure = "reap-failed"
						break
					}
					if pid == 0 {
						break
					}
					delete(delivered, pid)
					if pid == mainPID {
						mainReaped = true
						group = false
						code = execStatusCode(status)
						beginCancel(syscall.SIGTERM)
					}
				}
			}
			if !joined && cancelling && now.Sub(cancelAt) > 5*time.Second {
				// The truthful result is failure; no joined/exit status is manufactured.
				state = execFailure("cleanup-timeout")
				execSave(dir, state)
				for _, ch := range pending {
					ch <- state
				}
				pending = nil
				if process != nil {
					process.Release()
				}
				return 125
			}
			if joined && now.After(lease) {
				if process != nil {
					process.Release()
				}
				if !state.OK {
					return 125
				}
				if started {
					return code
				}
				return 0
			}
		}
	}
}

// Cleanup is called only after the transport owner has inspected the primary
// exec as stopped. A still-present listener or missing joined receipt refuses it.
func runExecCleanup(args []string, streams helperIO) int {
	if len(args) != 2 || !validExecSession(args[0], args[1]) {
		return execEmit(streams.stdout, execFailure("invalid-session"))
	}
	dir := args[0]
	if execCheckPrivateDirectory(dir) != nil {
		return execEmit(streams.stdout, execFailure("unsafe-session"))
	}
	lock, err := execLock(dir)
	if err != nil {
		return execEmit(streams.stdout, execFailure("session-lock-failed"))
	}
	defer execUnlock(lock)
	r, ok := execLoad(dir)
	if !ok || !r.OK || !r.Joined || execExists(dir, "control") {
		return execEmit(streams.stdout, execFailure("cleanup-not-confirmed"))
	}
	allowed := map[string]bool{"initialized": true, "launched": true, "supervisor": true, "cancelled": true, "cancel-sigint": true, "result": true, "result.tmp": true, "lock": true}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) > len(allowed) {
		return execEmit(streams.stdout, execFailure("unsafe-session"))
	}
	for _, entry := range entries {
		info, e := os.Lstat(filepath.Join(dir, entry.Name()))
		if e != nil {
			return execEmit(streams.stdout, execFailure("unsafe-session"))
		}
		st, yes := info.Sys().(*syscall.Stat_t)
		if !allowed[entry.Name()] || !info.Mode().IsRegular() || !yes || st.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != 0600 {
			return execEmit(streams.stdout, execFailure("unsafe-session"))
		}
	}
	for _, entry := range entries {
		if err = os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			return execEmit(streams.stdout, execFailure("session-cleanup-failed"))
		}
	}
	if os.Remove(dir) != nil {
		return execEmit(streams.stdout, execFailure("session-cleanup-failed"))
	}
	return execEmit(streams.stdout, execReply{OK: true, State: "collected", Joined: true})
}
