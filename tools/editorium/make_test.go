package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMakeFacadeHelpListingAndArgumentForwarding(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("GNU Make facade is exercised on Unix CI runners")
	}
	root := editoriumTestRepositoryRoot(t)
	help := runMakeTestCommand(t, root, nil, "help")
	for _, command := range []string{"make extensions", "make prepare", "make build", "make test", "make lint", "make clean", "make package", "make install", "make release", "make proto-sync", "make proto-generate", "make proto-check"} {
		if !strings.Contains(help, command) {
			t.Fatalf("make help does not list %q:\n%s", command, help)
		}
	}

	temporary := t.TempDir()
	logPath := filepath.Join(temporary, "calls.log")
	fakeTool := filepath.Join(temporary, "editorium-test-tool")
	writeTestFile(t, fakeTool, []byte("#!/bin/sh\nif [ \"$1\" = extensions ]; then echo vscode; fi\nprintf '%s|TARGET=%s|FORCE=%s|CODE=%s\\n' \"$*\" \"$TARGET\" \"$FORCE\" \"$CODE\" >> \"$MAKE_TEST_LOG\"\n"), 0o755)
	environment := []string{"MAKE_TEST_LOG=" + logPath}
	listing := runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "extensions")
	if strings.TrimSpace(listing) != "vscode" {
		t.Fatalf("make extensions = %q", listing)
	}
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "prepare")
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "prepare", "vscode")
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "prepare", "vscode", "jetbrains")
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "TARGET=linux-arm64", "package", "vscode")
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "CODE=code-insiders", "install", "vscode")
	runMakeTestCommand(t, root, environment, "TOOL="+fakeTool, "FORCE=1", "proto-sync")
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"run prepare|TARGET=|FORCE=|CODE=",
		"run prepare vscode|TARGET=|FORCE=|CODE=",
		"run prepare vscode jetbrains|TARGET=|FORCE=|CODE=",
		"package vscode|TARGET=linux-arm64|FORCE=|CODE=",
		"install vscode|TARGET=|FORCE=|CODE=code-insiders",
		"proto sync|TARGET=|FORCE=1|CODE=",
	} {
		if !strings.Contains(string(contents), expected) {
			t.Fatalf("Make forwarding log does not contain %q:\n%s", expected, contents)
		}
	}
}

func TestCommandArgumentValidationFailsBeforeWork(t *testing.T) {
	tests := []struct {
		args []string
		want string
	}{
		{nil, "Usage:"},
		{[]string{"package"}, "exactly one extension"},
		{[]string{"package", "vscode", "extra"}, "exactly one extension"},
		{[]string{"install"}, "exactly one extension"},
		{[]string{"release", "vscode"}, "exactly one extension and one version"},
		{[]string{"release", "vscode", "0.1.0", "extra"}, "exactly one extension and one version"},
		{[]string{"run", "build", "unknown"}, "Available integrations"},
		{[]string{"proto", "generate"}, "exactly one extension"},
	}
	root := editoriumTestRepositoryRoot(t)
	oldDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldDirectory) })
	for _, test := range tests {
		err := execute(context.Background(), test.args)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("execute(%v) error = %v, want %q", test.args, err, test.want)
		}
	}
}

func TestRepositoryRootUsesEditoriumMarkersWithoutNPMMetadata(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte("{\"ferretd\":\"1.2.3\"}\n"), 0o644)
	writeTestFile(t, filepath.Join(root, "Makefile"), []byte("help:\n\t@true\n"), 0o644)
	nested := filepath.Join(root, "extensions", "vscode", "src")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"package.json", "package-lock.json"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("root %s unexpectedly exists: %v", name, err)
		}
	}

	oldDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(nested); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldDirectory) })

	got, err := repositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	gotInfo, err := os.Stat(got)
	if err != nil {
		t.Fatal(err)
	}
	wantInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(gotInfo, wantInfo) {
		t.Fatalf("repositoryRoot() = %q, want repository at %q", got, root)
	}
}

func editoriumTestRepositoryRoot(t *testing.T) string {
	t.Helper()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Clean(filepath.Join(workingDirectory, "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "Makefile")); err != nil {
		t.Fatalf("cannot locate repository root: %v", err)
	}
	return root
}

func runMakeTestCommand(t *testing.T, root string, environment []string, args ...string) string {
	t.Helper()
	command := exec.Command("make", append([]string{"-s", "-f", "Makefile"}, args...)...)
	command.Dir = root
	command.Env = append(os.Environ(), environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("make %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}
