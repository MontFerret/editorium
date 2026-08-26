package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func runJetBrainsOperation(ctx context.Context, root, operation string) error {
	switch operation {
	case "prepare":
		fmt.Println("The JetBrains extension requires no external preparation.")
		return nil
	case "build":
		return runJetBrainsGradle(ctx, root, "buildPlugin", "verifyPluginProjectConfiguration", "verifyPluginStructure")
	case "test":
		return runJetBrainsGradle(ctx, root, "test")
	case "lint":
		return runJetBrainsGradle(ctx, root, "compileKotlin", "compileTestKotlin", "verifyPluginProjectConfiguration", "verifyPluginStructure", "verifyPlugin")
	case "clean":
		return cleanJetBrains(root)
	default:
		return fmt.Errorf("unknown JetBrains operation %q", operation)
	}
}

func packageJetBrains(ctx context.Context, root string) error {
	return runJetBrainsGradle(ctx, root, "buildPlugin", "verifyPluginProjectConfiguration", "verifyPluginStructure", "verifyPlugin")
}

func runJetBrainsGradle(ctx context.Context, root string, args ...string) error {
	packageRoot := jetbrainsPackageRoot(root)
	wrapper := "gradlew"
	if runtime.GOOS == "windows" {
		wrapper += ".bat"
	}
	return runCommand(ctx, packageRoot, nil, filepath.Join(packageRoot, wrapper), args...)
}

func jetbrainsPackageRoot(root string) string {
	return filepath.Join(root, "extensions", "jetbrains")
}

func cleanJetBrains(root string) error {
	return os.RemoveAll(filepath.Join(jetbrainsPackageRoot(root), "build"))
}
