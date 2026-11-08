package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const (
	execCancelGrace   = 500 * time.Millisecond
	execCancelJoinMax = 5 * time.Second
	execControlRead   = 32 * 1024
)

func runExecRun(args []string, streams helperIO) int {
	return runExecRunWithScan(args, streams, execDirectChildren)
}

func runExecRunWithScan(args []string, streams helperIO, scan func() ([]int, error)) int {
	if len(args) < 2 || args[0] != "--" {
		return 64
	}
	argv := args[1:]
	outFile, outOK := streams.stdout.(*os.File)
	errFile, errOK := streams.stderr.(*os.File)
	inFile, inOK := streams.stdin.(*os.File)
	if !outOK || !errOK || !inOK {
		return 125
	}

	// PR_SET_CHILD_SUBREAPER: adopted double-fork/setsid children remain ours.
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0)
	if errno != 0 {
		return 125
	}
	if _, err := scan(); err != nil {
		return 125
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return 125
	}

	path, lookErr := exec.LookPath(argv[0])
	if lookErr != nil {
		stdinR.Close()
		stdinW.Close()
		return execLaunchFailure(streams, argv[0], lookErr)
	}
	process, startErr := os.StartProcess(path, argv, &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{stdinR, outFile, errFile},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	stdinR.Close()
	if startErr != nil {
		stdinW.Close()
		return execLaunchFailure(streams, argv[0], startErr)
	}

	mainPID := process.Pid
	// Catch SIGPIPE only in this helper after launch; do not make children inherit SIG_IGN.
	sigpipe := make(chan os.Signal, 1)
	signal.Notify(sigpipe, syscall.SIGPIPE)
	defer signal.Stop(sigpipe)
	controlFD := int(inFile.Fd())
	writeFD := int(stdinW.Fd())
	if syscall.SetNonblock(controlFD, true) != nil || syscall.SetNonblock(writeFD, true) != nil {
		process.Kill()
		process.Wait()
		stdinW.Close()
		return 125
	}
	defer stdinW.Close()

	// Backpressure solution: control reads never wait on child-stdin writability.
	// Complete frames are buffered in-memory (DATA max 64KiB each); pending child
	// writes drain opportunistically. SIGNAL/EOF/raw-EOF are handled as soon as
	// their frame is complete, even while a prior DATA chunk is still blocked.
	parser := execFrameParser{}
	readBuf := make([]byte, execControlRead)
	var pending []byte
	stdinOpen := true
	stdinEOF := false
	controlOpen := true
	cancelling := false
	var cancelAt time.Time
	var cancelSignal syscall.Signal = syscall.SIGTERM
	delivered := make(map[int]syscall.Signal)
	var groupDelivered syscall.Signal
	group := true
	mainReaped := false
	code := 0
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	closeStdin := func() {
		if stdinOpen {
			stdinOpen = false
			stdinW.Close()
		}
	}
	beginCancel := func(sig syscall.Signal) {
		if cancelling {
			return
		}
		cancelling = true
		cancelAt = time.Now()
		cancelSignal = sig
		closeStdin()
		controlOpen = false
	}
	reap := func() (done bool) {
		for {
			var status syscall.WaitStatus
			pid, e := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if e == syscall.EINTR {
				continue
			}
			if e == syscall.ECHILD {
				return mainReaped
			}
			if e != nil || pid == 0 {
				return false
			}
			delete(delivered, pid)
			if pid == mainPID {
				mainReaped = true
				group = false
				if !cancelling {
					code = execStatusCode(status)
					return true
				}
			}
		}
	}
	signalRound := func(now time.Time) {
		sig := cancelSignal
		if now.Sub(cancelAt) >= execCancelGrace {
			sig = syscall.SIGKILL
		}
		if err := execSignalTree(mainPID, group, sig, delivered, &groupDelivered, scan); err != nil {
			groupDelivered = 0
		}
	}

	for {
		if controlOpen {
			for reads := 0; reads < 8 && controlOpen; reads++ {
				n, e := syscall.Read(controlFD, readBuf)
				if n > 0 {
					if parser.Feed(readBuf[:n]) != nil {
						beginCancel(syscall.SIGTERM)
						break
					}
					for {
						frame, ferr := parser.Next()
						if ferr == errExecFrameIncomplete {
							break
						}
						if ferr != nil {
							beginCancel(syscall.SIGTERM)
							break
						}
						switch frame.Type {
						case execFrameData:
							if stdinOpen {
								pending = append(pending, frame.Payload...)
							}
						case execFrameEOF:
							// Logical EOF closes child stdin after draining pending DATA;
							// control stays open for later SIGNAL frames.
							stdinEOF = true
						case execFrameSignal:
							sig, _ := execFrameSignalValue(frame.Payload)
							if sig == execSignalInterrupt {
								beginCancel(syscall.SIGINT)
							} else {
								beginCancel(syscall.SIGTERM)
							}
						}
						if cancelling {
							break
						}
					}
					continue
				}
				if e == syscall.EAGAIN || e == syscall.EWOULDBLOCK || e == syscall.EINTR {
					break
				}
				// Raw control EOF or hard read error: host death/disconnect.
				beginCancel(syscall.SIGTERM)
				break
			}
		}

		// Drain pending DATA without blocking the next control read.
		for stdinOpen && len(pending) > 0 {
			n, e := syscall.Write(writeFD, pending)
			if n > 0 {
				pending = pending[n:]
			}
			if e == syscall.EAGAIN || e == syscall.EWOULDBLOCK || e == syscall.EINTR {
				break
			}
			if e != nil {
				pending = pending[:0]
				closeStdin()
				break
			}
			if n == 0 {
				break
			}
		}
		if stdinOpen && stdinEOF && len(pending) == 0 {
			closeStdin()
		}

		if reap() {
			process.Release()
			if cancelling {
				return 128 + int(cancelSignal)
			}
			return code
		}
		if mainReaped && !cancelling {
			// Natural main completion: do not wait for background descendants.
			process.Release()
			return code
		}
		if cancelling {
			now := time.Now()
			signalRound(now)
			if reap() {
				process.Release()
				return 128 + int(cancelSignal)
			}
			if now.Sub(cancelAt) > execCancelJoinMax {
				process.Release()
				return 125
			}
		}
		<-ticker.C
	}
}

func execLaunchFailure(streams helperIO, program string, err error) int {
	message := "cannot execute"
	code := 126
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist), errors.Is(err, syscall.ENOENT):
		code, message = 127, "command not found"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.ENOEXEC):
		code = 126
	default:
		if pe, ok := err.(*os.PathError); ok && errors.Is(pe.Err, syscall.ENOENT) {
			code, message = 127, "command not found"
		}
	}
	fmt.Fprintf(streams.stderr, "lando: %s: %s\n", program, message)
	return code
}
