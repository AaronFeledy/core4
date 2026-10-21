package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

type proxyRequest struct {
	Tag  string            `json:"_tag"`
	Argv []string          `json:"argv"`
	Cwd  string            `json:"cwd"`
	TTY  bool              `json:"tty"`
	Env  map[string]string `json:"env"`
}

func runHostProxy(ctx context.Context, args []string, streams helperIO) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 127
	}
	argv := append([]string{}, args...)
	return runProxyCall(ctx, proxyCall{"runLando", proxyRequest{"runLando", argv, cwd, isTerminal(streams.stdout), parsePolicy().filter(streams.env)}}, streams)
}

type proxyCall struct {
	operation string
	payload   proxyPayload
}

type proxyPayload interface{ proxyPayload() }

func (proxyRequest) proxyPayload() {}

func runProxyCall(ctx context.Context, call proxyCall, streams helperIO) int {
	env := streams.env
	if env["LANDO_HOST_PROXY_SOCKET"] == "" && env["LANDO_HOST_PROXY_URL"] == "" {
		fmt.Fprintf(streams.stderr, "Missing LANDO_HOST_PROXY_SOCKET or LANDO_HOST_PROXY_URL for host-proxy %s.\n", call.operation)
		return 127
	}
	for _, name := range []string{"LANDO_HOST_PROXY_SESSION", "LANDO_HOST_PROXY_APP", "LANDO_HOST_PROXY_TOKEN"} {
		if env[name] == "" {
			fmt.Fprintf(streams.stderr, "Missing %s for host-proxy %s.\n", name, call.operation)
			return 127
		}
	}
	code, err := proxyExchange(ctx, call, streams)
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 127
	}
	return code
}

func proxyExchange(ctx context.Context, call proxyCall, streams helperIO) (int, error) {
	env := streams.env
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	target := "http://localhost/" + call.operation
	if raw := env["LANDO_HOST_PROXY_URL"]; raw != "" {
		base, err := url.Parse(raw)
		if err != nil {
			return 127, err
		}
		// The original node:http client uses the URL's host and port, not TLS.
		target = (&url.URL{Scheme: "http", Host: base.Host, Path: "/" + call.operation}).String()
	} else {
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", env["LANDO_HOST_PROXY_SOCKET"])
		}
	}
	body, err := json.Marshal(call.payload)
	if err != nil {
		return 127, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return 127, err
	}
	caller := env["LANDO_HOST_PROXY_CALLER"]
	if caller == "" {
		caller = "unknown"
	}
	req.Header.Set("authorization", "Bearer "+env["LANDO_HOST_PROXY_TOKEN"])
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-lando-host-proxy-app", env["LANDO_HOST_PROXY_APP"])
	req.Header.Set("x-lando-host-proxy-session", env["LANDO_HOST_PROXY_SESSION"])
	req.Header.Set("x-lando-host-proxy-caller", caller)
	req.Header.Set("x-lando-host-proxy-depth", parseDepth(env["LANDO_HOST_PROXY_DEPTH"]))
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return 127, err
	}
	defer res.Body.Close()
	if call.operation != "runLando" {
		return readOpenResponse(res.Body, streams)
	}
	return readProxyFrames(res.Body, streams)
}

func readProxyFrames(input io.Reader, streams helperIO) (int, error) {
	reader := bufio.NewReader(input)
	code := 1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return code, nil
			} // Ignore an unterminated frame, like the original.
			return 127, err
		}
		line = strings.TrimSuffix(line, "\n")
		if line == "" {
			continue
		}
		var fields map[string]json.RawMessage
		if !json.Valid([]byte(line)) {
			fmt.Fprintln(streams.stderr, "Invalid host-proxy frame: invalid JSON")
			return 1, nil
		}
		if json.Unmarshal([]byte(line), &fields) != nil {
			continue
		}
		var kind string
		if json.Unmarshal(fields["kind"], &kind) != nil {
			continue
		}
		var text *string
		switch kind {
		case "stdout", "stderr":
			if json.Unmarshal(fields["chunk"], &text) != nil || text == nil {
				continue
			}
			out := streams.stdout
			if kind == "stderr" {
				out = streams.stderr
			}
			if _, err := io.WriteString(out, *text); err != nil {
				return 127, err
			}
		case "error":
			if json.Unmarshal(fields["message"], &text) != nil || text == nil {
				continue
			}
			if _, err := fmt.Fprintln(streams.stderr, *text); err != nil {
				return 127, err
			}
			code = 1
		case "exit":
			var number *float64
			if json.Unmarshal(fields["code"], &number) == nil && number != nil {
				code = int(*number)
			}
		}
	}
}

var decimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var radixNumber = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)

func parseDepth(raw string) string {
	text := strings.TrimFunc(raw, func(r rune) bool {
		return strings.ContainsRune("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff", r)
	})
	var value float64
	if len(text) > 2 && text[0] == '0' && strings.ContainsRune("xXoObB", rune(text[1])) {
		if !radixNumber.MatchString(text) {
			return "0"
		}
		integer, ok := new(big.Int).SetString(text, 0)
		if !ok {
			return "0"
		}
		value, _ = new(big.Float).SetInt(integer).Float64()
	} else {
		if !decimalNumber.MatchString(text) {
			return "0"
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return "0"
		}
		value = parsed
	}
	if math.IsInf(value, 0) || math.IsNaN(value) || value == 0 {
		return "0"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func isTerminal(output io.Writer) bool {
	file, ok := output.(*os.File)
	if !ok {
		return false
	}
	var termios syscall.Termios
	// TCGETS requires a pointer to writable termios storage, alive for this syscall.
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&termios)))
	return errno == 0
}
