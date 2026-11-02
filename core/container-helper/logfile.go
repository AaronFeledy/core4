package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

const maxSafeInteger = 9007199254740991

var unsignedDecimal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
var cleanupDirectory = regexp.MustCompile(`^/tmp/lando-log-file-helper-[0-9a-f]{32}$`)

type logCommand struct {
	op       string
	path     string
	offset   string
	maxBytes int64
}

type logStat struct {
	Dev  string `json:"dev"`
	Ino  string `json:"ino"`
	Size string `json:"size"`
}

type logResponse struct {
	OK         bool     `json:"ok"`
	Code       string   `json:"code,omitempty"`
	Message    string   `json:"message,omitempty"`
	Stat       *logStat `json:"stat,omitempty"`
	Missing    bool     `json:"missing,omitempty"`
	Bytes      *string  `json:"bytes,omitempty"`
	NextOffset string   `json:"nextOffset,omitempty"`
	EOF        *bool    `json:"eof,omitempty"`
}

func decodeCommand(line []byte) (logCommand, logResponse) {
	var fields map[string]json.RawMessage
	if !json.Valid(line) {
		var value json.RawMessage
		err := json.Unmarshal(line, &value)
		return logCommand{}, logFailure("EIO", err.Error())
	}
	invalid := logFailure("EPROTO", "invalid helper command")
	var cmd logCommand
	if json.Unmarshal(line, &fields) != nil {
		return cmd, invalid
	}
	if json.Unmarshal(fields["op"], &cmd.op) != nil {
		return cmd, invalid
	}
	switch cmd.op {
	case "stat", "open":
		var path *string
		if json.Unmarshal(fields["path"], &path) != nil || path == nil {
			return logCommand{}, invalid
		}
		cmd.path = *path
	case "fstat", "close":
	case "read":
		var length *float64
		if json.Unmarshal(fields["offset"], &cmd.offset) != nil || !unsignedDecimal.MatchString(cmd.offset) {
			return logCommand{}, invalid
		}
		if json.Unmarshal(fields["maxBytes"], &length) != nil || length == nil || *length < 0 || *length > maxSafeInteger || math.Trunc(*length) != *length {
			return logCommand{}, invalid
		}
		cmd.maxBytes = int64(*length)
	default:
		return logCommand{}, invalid
	}
	return cmd, logResponse{OK: true}
}

type logFile struct{ handle *os.File }

func (f *logFile) close() error {
	current := f.handle
	f.handle = nil
	if current != nil {
		return current.Close()
	}
	return nil
}

func (f *logFile) run(cmd logCommand) logResponse {
	switch cmd.op {
	case "stat":
		var stat syscall.Stat_t
		if err := syscall.Stat(cmd.path, &stat); err != nil {
			if errors.Is(err, syscall.ENOENT) {
				return logResponse{OK: true, Missing: true}
			}
			return logError(err)
		}
		return statResponse(stat)
	case "open":
		if err := f.close(); err != nil {
			return logError(err)
		}
		handle, err := os.Open(cmd.path)
		if err != nil {
			return logError(err)
		}
		f.handle = handle
		return f.stat()
	case "close":
		if err := f.close(); err != nil {
			return logError(err)
		}
		return logResponse{OK: true}
	case "fstat", "read":
		if f.handle == nil {
			return logFailure("EBADF", "log file is not open")
		}
		if cmd.op == "fstat" {
			return f.stat()
		}
		offset, err := strconv.ParseInt(cmd.offset, 10, 64)
		if err != nil || offset > maxSafeInteger {
			return logFailure("ERANGE", "read offset is outside the safe positional-read range")
		}
		length := min(cmd.maxBytes, 65536)
		buffer := make([]byte, length)
		n, err := f.handle.ReadAt(buffer, offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return logError(err)
		}
		encoded := base64.StdEncoding.EncodeToString(buffer[:n])
		eof := int64(n) < length
		return logResponse{OK: true, Bytes: &encoded, NextOffset: strconv.FormatInt(offset+int64(n), 10), EOF: &eof}
	default:
		return logFailure("EPROTO", "invalid helper command")
	}
}

func (f *logFile) stat() logResponse {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(f.handle.Fd()), &stat); err != nil {
		return logError(err)
	}
	return statResponse(stat)
}

func statResponse(stat syscall.Stat_t) logResponse {
	return logResponse{OK: true, Stat: &logStat{strconv.FormatUint(uint64(stat.Dev), 10), strconv.FormatUint(stat.Ino, 10), strconv.FormatInt(stat.Size, 10)}}
}

func logFailure(code, message string) logResponse { return logResponse{Code: code, Message: message} }

func logError(err error) logResponse {
	code := "EIO"
	for name, errno := range map[string]syscall.Errno{
		"ENOENT": syscall.ENOENT, "EACCES": syscall.EACCES, "ENOTDIR": syscall.ENOTDIR,
		"EISDIR": syscall.EISDIR, "ELOOP": syscall.ELOOP, "EPERM": syscall.EPERM,
		"EBADF": syscall.EBADF, "EINVAL": syscall.EINVAL, "EMFILE": syscall.EMFILE,
		"ENFILE": syscall.ENFILE, "ENAMETOOLONG": syscall.ENAMETOOLONG,
	} {
		if errors.Is(err, errno) {
			code = name
			break
		}
	}
	return logFailure(code, err.Error())
}

func runLogFile(input io.Reader, output io.Writer) (err error) {
	file := &logFile{}
	defer func() { err = errors.Join(err, file.close()) }()
	reader := bufio.NewReader(input)
	encoder := json.NewEncoder(output)
	for {
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 {
			cmd, response := decodeCommand([]byte(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")))
			if response.OK {
				response = file.run(cmd)
			}
			if err := encoder.Encode(response); err != nil {
				return err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func cleanupLogFile(path string, output io.Writer) error {
	response := logFailure("EPROTO", "invalid helper cleanup path")
	if cleanupDirectory.MatchString(path) {
		response = logResponse{OK: true}
		if err := os.RemoveAll(path); err != nil {
			response = logError(err)
		}
	}
	return json.NewEncoder(output).Encode(response)
}
