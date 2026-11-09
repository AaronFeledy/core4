package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

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
