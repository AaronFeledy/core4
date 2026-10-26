package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
)

var targetScheme = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
var errOpenArguments = errors.New("host-proxy open requires exactly one URL or path; flags are unsupported")

type openURLRequest struct {
	Tag string `json:"_tag"`
	URL string `json:"url"`
}

type openPathRequest struct {
	Tag  string `json:"_tag"`
	Path string `json:"path"`
}

func (openURLRequest) proxyPayload()  {}
func (openPathRequest) proxyPayload() {}

func openCall(args []string) (proxyCall, error) {
	if len(args) != 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		return proxyCall{}, errOpenArguments
	}
	if targetScheme.MatchString(args[0]) {
		return proxyCall{"openUrl", openURLRequest{"openUrl", args[0]}}, nil
	}
	path, err := filepath.Abs(args[0])
	if err != nil {
		return proxyCall{}, fmt.Errorf("resolve host-proxy open path: %w", err)
	}
	return proxyCall{"openPath", openPathRequest{"openPath", path}}, nil
}

func runHostOpen(ctx context.Context, args []string, streams helperIO) int {
	call, err := openCall(args)
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 64
	}
	return runProxyCall(ctx, call, streams)
}

func readOpenResponse(input io.Reader, streams helperIO) (int, error) {
	var response struct {
		Tag         string `json:"_tag"`
		Code        string `json:"code"`
		Message     string `json:"message"`
		Remediation string `json:"remediation"`
	}
	if err := json.NewDecoder(input).Decode(&response); err != nil {
		return 127, fmt.Errorf("decode host-proxy response: %w", err)
	}
	switch response.Tag {
	case "ok":
		return 0, nil
	case "error":
		if _, err := fmt.Fprintf(streams.stderr, "%s: %s\n", response.Code, response.Message); err != nil {
			return 127, err
		}
		if response.Remediation != "" {
			if _, err := fmt.Fprintln(streams.stderr, response.Remediation); err != nil {
				return 127, err
			}
		}
		return 1, nil
	default:
		return 127, errors.New("invalid host-proxy response tag")
	}
}
