package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const jetbrainsBufCommand = "github.com/bufbuild/buf/cmd/buf@v1.72.0"

func generateJetBrainsProto(ctx context.Context, root string, check bool) error {
	generatedRoot := filepath.Join(jetbrainsPackageRoot(root), "src", "main", "generated")
	outputRoot, cleanup, err := jetbrainsProtoOutputRoot(generatedRoot, check)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := runCommand(ctx, root, nil, "go", "run", jetbrainsBufCommand, "lint", "shared/proto", "--config", "buf.yaml"); err != nil {
		return err
	}

	template := jetbrainsProtoTemplate(root, outputRoot)

	templateJSON, err := json.Marshal(template)
	if err != nil {
		return err
	}

	if err := runCommand(ctx, root, nil, "go", "run", jetbrainsBufCommand, "generate", "--template", string(templateJSON)); err != nil {
		return err
	}

	if err := validateJetBrainsGeneratedTree(outputRoot); err != nil {
		return err
	}

	if check {
		return compareTrees(generatedRoot, outputRoot)
	}

	return replaceDirectoryAtomic(outputRoot, generatedRoot)
}

func jetbrainsProtoTemplate(root, outputRoot string) map[string]any {
	return map[string]any{
		"version": "v2",
		"clean":   true,
		"managed": map[string]any{
			"enabled": true,
			"override": []any{
				map[string]any{
					"file_option": "java_package_prefix",
					"value":       "org.ferretlang.jetbrains.protocol",
				},
				map[string]any{
					"file_option": "java_multiple_files",
					"value":       true,
				},
			},
		},
		"inputs": []any{map[string]any{
			"directory": root,
			"paths": []string{
				"shared/proto/ferretd/daemon/v1/daemon.proto",
				"shared/proto/ferretd/execution/v1/execution.proto",
				"shared/proto/ferretd/workspace/v1/workspace.proto",
				"shared/proto/google/rpc/status.proto",
			},
		}},
		"plugins": []any{
			map[string]any{
				"remote": "buf.build/protocolbuffers/java:v36.1",
				"out":    outputRoot,
			},
			map[string]any{
				"remote": "buf.build/grpc/java:v1.84.0",
				"out":    outputRoot,
			},
		},
	}
}

func validateJetBrainsGeneratedTree(root string) error {
	expected := []string{
		"org/ferretlang/jetbrains/protocol/ferretd/daemon/v1/DaemonServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/ferretd/execution/v1/ExecutionServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/ferretd/workspace/v1/WorkspaceServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/google/rpc/Status.java",
	}
	for _, relative := range expected {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("generated JetBrains protocol client is missing %s", relative)
		}
	}

	files := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if entry.IsDir() {
			return nil
		}

		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() || filepath.Ext(path) != ".java" {
			return fmt.Errorf("unexpected generated JetBrains protocol entry: %s", path)
		}

		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}

		if !strings.Contains(string(contents), "package org.ferretlang.jetbrains.protocol.") {
			return fmt.Errorf("generated JetBrains protocol file has an unexpected Java package: %s", path)
		}

		files++

		return nil
	})
	if err != nil {
		return err
	}

	if files == 0 {
		return fmt.Errorf("generated JetBrains protocol client is empty")
	}

	return nil
}

func jetbrainsProtoOutputRoot(generatedRoot string, check bool) (string, func(), error) {
	if check {
		root, err := os.MkdirTemp("", "ferret-jetbrains-proto-")
		return root, func() { _ = os.RemoveAll(root) }, err
	}

	parent := filepath.Dir(generatedRoot)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", func() {}, err
	}

	root, err := os.MkdirTemp(parent, ".generated-stage-")

	return root, func() { _ = os.RemoveAll(root) }, err
}
