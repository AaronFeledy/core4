package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func copyScaffoldTree(source string, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, destination)
	case info.IsDir():
		if err := os.Mkdir(destination, info.Mode().Perm()); err != nil {
			return err
		}
		children, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := copyScaffoldTree(
				filepath.Join(source, child.Name()),
				filepath.Join(destination, child.Name()),
			); err != nil {
				return err
			}
		}
		syncDir(destination)
		return nil
	case info.Mode().IsRegular():
		return copyScaffoldFile(source, destination, info.Mode().Perm())
	default:
		return fmt.Errorf("Unsupported scaffold entry type: %s", source)
	}
}

func copyScaffoldFile(source string, destination string, mode fs.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := output.ReadFrom(input); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func scaffoldToken() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("v1-%d", os.Getpid())
	}
	return hex.EncodeToString(bytes)
}
