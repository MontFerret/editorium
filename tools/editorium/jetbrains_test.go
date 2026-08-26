package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestJetBrainsOperationsUseIntegrationLocalGradleWrapper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell wrapper fixture is exercised on Unix")
	}
	root := t.TempDir()
	packageRoot := jetbrainsPackageRoot(root)
	logPath := filepath.Join(root, "gradle-calls.log")
	wrapper := filepath.Join(packageRoot, "gradlew")
	writeTestFile(t, wrapper, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$JETBRAINS_TEST_LOG\"\n"), 0o755)
	t.Setenv("JETBRAINS_TEST_LOG", logPath)

	if err := runJetBrainsOperation(context.Background(), root, "prepare"); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"build", "test", "lint"} {
		if err := runJetBrainsOperation(context.Background(), root, operation); err != nil {
			t.Fatal(err)
		}
	}
	if err := packageJetBrains(context.Background(), root); err != nil {
		t.Fatal(err)
	}

	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"buildPlugin verifyPluginProjectConfiguration verifyPluginStructure",
		"test",
		"compileKotlin compileTestKotlin verifyPluginProjectConfiguration verifyPluginStructure verifyPlugin",
		"buildPlugin verifyPluginProjectConfiguration verifyPluginStructure verifyPlugin",
	} {
		if !strings.Contains(string(contents), expected) {
			t.Fatalf("Gradle calls do not contain %q:\n%s", expected, contents)
		}
	}
}

func TestCleanJetBrainsOwnsOnlyBuildOutput(t *testing.T) {
	root := t.TempDir()
	packageRoot := jetbrainsPackageRoot(root)
	for _, path := range []string{"build/distributions/plugin.zip", ".gradle/cache.bin", ".intellijPlatform/cache.bin", "src/main/kotlin/Keep.kt"} {
		writeTestFile(t, filepath.Join(packageRoot, path), []byte("data"), 0o644)
	}

	if err := cleanJetBrains(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(packageRoot, "build")); !os.IsNotExist(err) {
		t.Fatalf("JetBrains build output remains: %v", err)
	}
	for _, preserved := range []string{".gradle/cache.bin", ".intellijPlatform/cache.bin", "src/main/kotlin/Keep.kt"} {
		if _, err := os.Stat(filepath.Join(packageRoot, preserved)); err != nil {
			t.Fatalf("clean removed %s: %v", preserved, err)
		}
	}
}
