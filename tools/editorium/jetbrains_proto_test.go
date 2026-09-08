package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestProtoDispatcherSelectsJetBrainsGenerator(t *testing.T) {
	generator, err := protoGeneratorForExtension("jetbrains")
	if err != nil {
		t.Fatal(err)
	}

	if reflect.ValueOf(generator).Pointer() != reflect.ValueOf(protoGenerator(generateJetBrainsProto)).Pointer() {
		t.Fatal("JetBrains protocol dispatch selected the wrong generator")
	}

	if _, err := protoGeneratorForExtension("unsupported"); err == nil {
		t.Fatal("unsupported protocol generator was accepted")
	}
}

func TestJetBrainsProtoTemplatePinsGeneratorAndManagedJavaOptions(t *testing.T) {
	encoded, err := json.Marshal(jetbrainsProtoTemplate("/repo", "/generated"))
	if err != nil {
		t.Fatal(err)
	}

	value := string(encoded)
	for _, expected := range []string{
		`"remote":"buf.build/protocolbuffers/java:v36.1"`,
		`"remote":"buf.build/grpc/java:v1.84.0"`,
		`"file_option":"java_package_prefix","value":"org.ferretlang.jetbrains.protocol"`,
		`"file_option":"java_multiple_files","value":true`,
		`"out":"/generated"`,
		`"directory":"/repo"`,
	} {
		if !strings.Contains(value, expected) {
			t.Fatalf("JetBrains Buf template does not contain %s:\n%s", expected, value)
		}
	}

	if jetbrainsBufCommand != "github.com/bufbuild/buf/cmd/buf@v1.72.0" {
		t.Fatalf("Buf command = %q", jetbrainsBufCommand)
	}
}

func TestValidateJetBrainsGeneratedTreeRejectsMissingUnexpectedAndWrongPackages(t *testing.T) {
	root := t.TempDir()
	writeJetBrainsGeneratedFixture(t, root)
	if err := validateJetBrainsGeneratedTree(root); err != nil {
		t.Fatal(err)
	}

	missing := filepath.Join(root, "org/ferretlang/jetbrains/protocol/google/rpc/Status.java")
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}

	if err := validateJetBrainsGeneratedTree(root); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing-file validation error = %v", err)
	}

	writeTestFile(t, missing, []byte("package org.ferretlang.jetbrains.protocol.google.rpc;\n"), 0o644)

	unexpected := filepath.Join(root, "unexpected.txt")
	writeTestFile(t, unexpected, []byte("unexpected"), 0o644)
	if err := validateJetBrainsGeneratedTree(root); err == nil || !strings.Contains(err.Error(), "unexpected") {
		t.Fatalf("unexpected-file validation error = %v", err)
	}

	if err := os.Remove(unexpected); err != nil {
		t.Fatal(err)
	}

	writeTestFile(t, missing, []byte("package wrong;\n"), 0o644)
	if err := validateJetBrainsGeneratedTree(root); err == nil || !strings.Contains(err.Error(), "unexpected Java package") {
		t.Fatalf("wrong-package validation error = %v", err)
	}
}

func TestJetBrainsProtoGenerationStagesAtomicallyAndCheckReportsDrift(t *testing.T) {
	parent := t.TempDir()
	generated := filepath.Join(parent, "generated")
	writeJetBrainsGeneratedFixture(t, generated)

	staging, cleanup, err := jetbrainsProtoOutputRoot(generated, false)
	if err != nil {
		t.Fatal(err)
	}

	defer cleanup()

	if filepath.Dir(staging) != parent {
		t.Fatalf("generation staging parent = %s, want %s", filepath.Dir(staging), parent)
	}

	writeJetBrainsGeneratedFixture(t, staging)
	changed := filepath.Join(staging, "org/ferretlang/jetbrains/protocol/google/rpc/Status.java")
	writeTestFile(t, changed, []byte("package org.ferretlang.jetbrains.protocol.google.rpc;\n// regenerated\n"), 0o644)

	if err := replaceDirectoryAtomic(staging, generated); err != nil {
		t.Fatal(err)
	}

	assertTestContents(
		t,
		filepath.Join(generated, "org/ferretlang/jetbrains/protocol/google/rpc/Status.java"),
		"package org.ferretlang.jetbrains.protocol.google.rpc;\n// regenerated\n",
	)

	check, checkCleanup, err := jetbrainsProtoOutputRoot(generated, true)
	if err != nil {
		t.Fatal(err)
	}

	defer checkCleanup()

	writeJetBrainsGeneratedFixture(t, check)
	err = compareTrees(generated, check)
	if err == nil || !strings.Contains(err.Error(), "outdated generated file") {
		t.Fatalf("JetBrains protocol drift error = %v", err)
	}
}

func writeJetBrainsGeneratedFixture(t *testing.T, root string) {
	t.Helper()
	for _, relative := range []string{
		"org/ferretlang/jetbrains/protocol/ferretd/daemon/v1/DaemonServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/ferretd/execution/v1/ExecutionServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/ferretd/workspace/v1/WorkspaceServiceGrpc.java",
		"org/ferretlang/jetbrains/protocol/google/rpc/Status.java",
	} {
		writeTestFile(
			t,
			filepath.Join(root, filepath.FromSlash(relative)),
			[]byte("package org.ferretlang.jetbrains.protocol.fixture;\n"),
			0o644,
		)
	}
}
