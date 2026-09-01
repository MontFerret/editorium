package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func extensionNames() []string {
	return []string{"jetbrains", "vscode"}
}

func validateExtensions(names []string) error {
	available := extensionNames()
	known := make(map[string]struct{}, len(available))
	for _, name := range available {
		known[name] = struct{}{}
	}

	seen := make(map[string]struct{})
	for _, name := range names {
		if _, ok := known[name]; !ok {
			return usageError(fmt.Sprintf("unknown extension: %s", name))
		}

		if _, duplicate := seen[name]; duplicate {
			return usageError(fmt.Sprintf("extension may only be specified once: %s", name))
		}

		seen[name] = struct{}{}
	}

	return nil
}

func runExtensions(ctx context.Context, root, operation string, names []string) error {
	switch operation {
	case "prepare", "build", "test", "lint", "clean":
	default:
		return fmt.Errorf("unknown integration operation %q", operation)
	}

	unscoped := len(names) == 0
	if unscoped {
		names = extensionNames()
	}

	if err := validateExtensions(names); err != nil {
		return err
	}

	for _, name := range names {
		fmt.Printf("Running %s for extension %q\n", operation, name)
		switch name {
		case "jetbrains":
			if err := runJetBrainsOperation(ctx, root, operation); err != nil {
				return err
			}
		case "vscode":
			if err := runVSCodeOperation(ctx, root, operation); err != nil {
				return err
			}
		}
	}

	if operation == "clean" && unscoped {
		for _, path := range []string{
			filepath.Join(root, ".dist"),
			filepath.Join(root, "shared", "proto", "ferretd"),
		} {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
	}

	return nil
}

func runExplicitExtension(ctx context.Context, root, operation, name string) error {
	if err := validateExtensions([]string{name}); err != nil {
		return err
	}

	switch name {
	case "jetbrains":
		switch operation {
		case "package":
			return packageJetBrains(ctx, root)
		case "package-check":
			return checkJetBrainsPackage(ctx, root)
		default:
			return fmt.Errorf("extension %q does not implement %s", name, operation)
		}
	case "vscode":
		return runExplicitVSCodeOperation(ctx, root, operation)
	default:
		return fmt.Errorf("extension %q does not implement %s", name, operation)
	}
}

func runExplicitVSCodeOperation(ctx context.Context, root, operation string) error {
	target, err := selectedTarget()
	if err != nil {
		return err
	}

	switch operation {
	case "package":
		_, err = packageVSCodeTarget(ctx, root, target)
	case "package-check":
		err = checkVSCodeTarget(ctx, root, target)
	case "install":
		var packaged packagedTarget
		packaged, err = packageVSCodeTarget(ctx, root, target)
		if err == nil {
			err = installVSCodeTarget(ctx, root, packaged)
		}
	case "matrix":
		matrix := struct {
			Include []vscodeTarget `json:"include"`
		}{Include: vscodeTargets}
		var encoded []byte
		encoded, err = json.Marshal(matrix)
		if err == nil {
			fmt.Println(string(encoded))
		}
	case "test-installed":
		err = testInstalledVSIX(ctx, root, target)
	default:
		err = fmt.Errorf("unsupported explicit operation %q", operation)
	}

	return err
}

func availableIntegrations() string {
	return strings.Join(extensionNames(), "\n  ")
}
