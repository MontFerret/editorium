package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func runCommand(ctx context.Context, root string, environment []string, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = root
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = append(os.Environ(), environment...)

	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", commandLine(name, args), err)
	}

	return nil
}

func commandOutput(ctx context.Context, root string, environment []string, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = root
	command.Env = append(os.Environ(), environment...)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return "", fmt.Errorf("%s failed: %s: %w", commandLine(name, args), detail, err)
		}

		return "", fmt.Errorf("%s failed: %w", commandLine(name, args), err)
	}

	return stdout.String(), nil
}

func commandLine(name string, args []string) string {
	return strings.Join(append([]string{name}, args...), " ")
}

func nodeBinEnvironment(packageRoot string) []string {
	path := filepath.Join(packageRoot, "node_modules", ".bin") + string(os.PathListSeparator) + os.Getenv("PATH")

	return []string{"PATH=" + path}
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".cmd"
	}

	return name
}

func copyLimited(destination io.Writer, source io.Reader, maximum int64, label string) error {
	limited := &io.LimitedReader{R: source, N: maximum + 1}
	written, err := io.Copy(destination, limited)
	if err != nil {
		return err
	}

	if written > maximum {
		return fmt.Errorf("%s exceeds the size limit", label)
	}

	return nil
}
