package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const usage = `Usage:
  editorium extensions
  editorium run <prepare|build|test|lint|clean> [extension ...]
  editorium package <extension>
  editorium package-check <extension>
  editorium install <extension>
  editorium matrix <extension>
  editorium test-installed <extension>
  editorium proto <sync|generate|check> [extension]
  editorium release <extension> <version>
  editorium release-ci <metadata|check-assets|state> [options]`

func main() {
	if err := execute(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func execute(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return usageError("")
	}

	root, err := repositoryRoot()
	if err != nil {
		return err
	}

	switch args[0] {
	case "extensions":
		if len(args) != 1 {
			return usageError("extensions accepts no arguments")
		}
		for _, name := range extensionNames() {
			fmt.Println(name)
		}
		return nil
	case "run":
		if len(args) < 2 {
			return usageError("run requires an operation")
		}
		return runExtensions(ctx, root, args[1], args[2:])
	case "package", "package-check", "install", "matrix", "test-installed":
		if len(args) != 2 {
			return usageError(fmt.Sprintf("%s requires exactly one extension", args[0]))
		}
		return runExplicitExtension(ctx, root, args[0], args[1])
	case "proto":
		return runProtoCommand(ctx, root, args[1:])
	case "release":
		if len(args) != 3 {
			return usageError("release requires exactly one extension and one version")
		}
		return runRelease(ctx, root, args[1], args[2])
	case "release-ci":
		return runReleaseCI(root, args[1:])
	default:
		return usageError(fmt.Sprintf("unknown command %q", args[0]))
	}
}

func usageError(message string) error {
	parts := make([]string, 0, 3)
	if message != "" {
		parts = append(parts, message)
	}
	parts = append(parts, usage, "Available integrations:\n  "+strings.Join(extensionNames(), "\n  "))
	return errors.New(strings.Join(parts, "\n"))
}

func repositoryRoot() (string, error) {
	current, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("get working directory: %w", err)
	}

	for directory := current; ; directory = filepath.Dir(directory) {
		if info, statErr := os.Stat(filepath.Join(directory, "ferretd.json")); statErr == nil && !info.IsDir() {
			if makeInfo, makeErr := os.Stat(filepath.Join(directory, "Makefile")); makeErr == nil && !makeInfo.IsDir() {
				return directory, nil
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
	}

	return "", fmt.Errorf("cannot find Editorium repository root from %s", current)
}

func envBool(name string) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	switch value {
	case "", "0", "false", "FALSE", "no", "NO":
		return false, nil
	case "1", "true", "TRUE", "yes", "YES":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be 1 or 0, got %q", name, value)
	}
}
