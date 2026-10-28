package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"syscall"
	"time"
)

const execWatchIdle = 3 * time.Second

// A watch owns no autonomous heartbeat. Each host pulse authorizes one local
// status request, and therefore one renewal of the supervisor's existing lease.
// Raw nonblocking reads avoid an uncancellable reader goroutine on inherited
// stdin (whose Go descriptor does not necessarily support read deadlines).
func runExecWatch(dir string, streams helperIO) int {
	input, ok := streams.stdin.(*os.File)
	if !ok {
		return execEmit(streams.stdout, execFailure("watch-input-unavailable"))
	}
	fd, err := syscall.Dup(int(input.Fd()))
	if err != nil {
		return execEmit(streams.stdout, execFailure("watch-input-unavailable"))
	}
	defer syscall.Close(fd)
	if syscall.SetNonblock(fd, true) != nil {
		return execEmit(streams.stdout, execFailure("watch-input-unavailable"))
	}
	output := streams.stdout
	if file, yes := output.(*os.File); yes {
		outFD, e := syscall.Dup(int(file.Fd()))
		if e != nil {
			return 1
		}
		defer syscall.Close(outFD)
		if syscall.SetNonblock(outFD, true) != nil {
			return 1
		}
		output = &execWatchWriter{fd: outFD}
	}
	return execWatchLoop(dir, output, func(p []byte) (int, error) { return syscall.Read(fd, p) }, execWatchIdle)
}

const execWatchMaxSeq int64 = 9007199254740991

type execWatchReply struct {
	execReply
	Seq int64 `json:"seq"`
}

func execWatchEmit(output io.Writer, reply execReply, seq int64) int {
	if json.NewEncoder(output).Encode(execWatchReply{reply, seq}) != nil || !reply.OK {
		return 1
	}
	return 0
}
func execWatchPulse(data []byte) (int64, bool) {
	for _, b := range data {
		if b > 127 {
			return 0, false
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return 0, false
	}
	seen := map[string]bool{}
	var seq int64
	for i := 0; i < 2; i++ {
		key, e := decoder.Token()
		if e != nil {
			return 0, false
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return 0, false
		}
		seen[name] = true
		value, e := decoder.Token()
		if e != nil {
			return 0, false
		}
		switch name {
		case "op":
			if value != "status" {
				return 0, false
			}
		case "seq":
			number, ok := value.(json.Number)
			if !ok {
				return 0, false
			}
			seq, e = strconv.ParseInt(string(number), 10, 64)
			if e != nil || seq < 1 || seq > execWatchMaxSeq {
				return 0, false
			}
		default:
			return 0, false
		}
	}
	token, err = decoder.Token()
	if err != nil || token != json.Delim('}') || !seen["op"] || !seen["seq"] {
		return 0, false
	}
	_, err = decoder.Token()
	return seq, err == io.EOF
}
func execWatchLoop(dir string, output io.Writer, read func([]byte) (int, error), idle time.Duration) int {
	pending := make([]byte, 0, 4096)
	buffer := make([]byte, 4097)
	deadline := time.Now().Add(idle)
	expectedSeq := int64(1)
	for {
		n, err := read(buffer)
		if n > 0 {
			pending = append(pending, buffer[:n]...)
			newline := bytes.IndexByte(pending, '\n')
			if newline < 0 {
				if len(pending) > 4096 {
					return execWatchEmit(output, execFailure("watch-input-too-large"), expectedSeq)
				}
			}
			if newline >= 0 {
				// Extra bytes already sent before this pulse's reply violate the single
				// in-flight request contract, including a partial next request.
				seq, valid := execWatchPulse(pending[:newline])
				if newline > 4096 || newline != len(pending)-1 || !valid || seq != expectedSeq {
					return execWatchEmit(output, execFailure("watch-invalid-input"), expectedSeq)
				}
				// Detect queued unsolicited bytes even when a read split the first line.
				extra, e := read(buffer)
				if extra > 0 {
					return execWatchEmit(output, execFailure("watch-invalid-input"), expectedSeq)
				}
				if e != nil && e != syscall.EAGAIN && e != syscall.EWOULDBLOCK && e != io.EOF {
					return execWatchEmit(output, execFailure("watch-input-failed"), expectedSeq)
				}
				// Share a two-second pulse budget between the local exchange and
				// its output write; a stalled peer cannot extend watch ownership.
				if writer, ok := output.(*execWatchWriter); ok {
					writer.deadline = time.Now().Add(2 * time.Second)
				}
				reply := execControlExchangeTimeout(dir, execRequest{Op: "status"}, time.Second)
				if code := execWatchEmit(output, reply, seq); code != 0 {
					return code
				}
				if writer, ok := output.(*execWatchWriter); ok {
					writer.deadline = time.Time{}
				}
				if reply.Joined {
					return 0
				}
				if e == io.EOF {
					return 0
				}
				pending = pending[:0]
				expectedSeq++
				deadline = time.Now().Add(idle)
			}
		}
		if err == io.EOF || (n == 0 && err == nil) {
			if len(pending) != 0 {
				return execWatchEmit(output, execFailure("watch-partial-input"), expectedSeq)
			}
			return 0
		}
		if err != nil && !errors.Is(err, syscall.EAGAIN) && !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			return execWatchEmit(output, execFailure("watch-input-failed"), expectedSeq)
		}
		if time.Now().After(deadline) {
			if len(pending) != 0 {
				return execWatchEmit(output, execFailure("watch-partial-input"), expectedSeq)
			}
			return 0
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Output backpressure may stop a watch, but can never keep its supervisor lease
// alive. Bound the write as well as input idle without a blocked I/O goroutine.
type execWatchWriter struct {
	fd       int
	deadline time.Time
}

func (w *execWatchWriter) Write(data []byte) (int, error) {
	written := 0
	deadline := w.deadline
	if deadline.IsZero() {
		deadline = time.Now().Add(execWatchIdle)
	}
	for written < len(data) {
		n, err := syscall.Write(w.fd, data[written:])
		if n > 0 {
			written += n
		}
		if err != nil && err != syscall.EAGAIN && err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			return written, err
		}
		if written == len(data) {
			return written, nil
		}
		if time.Now().After(deadline) {
			return written, errors.New("watch-output-timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return written, nil
}
