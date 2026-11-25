package main

import (
	"context"
	"runtime"
)

func installVSCodeReleaseDependencies(ctx context.Context, root string) error {
	if runtime.GOOS == "windows" {
		return runCommand(ctx, vscodePackageRoot(root), nil, "cmd.exe", "/d", "/c", "npm.cmd", "ci")
	}
	return runCommand(ctx, vscodePackageRoot(root), nil, "npm", "ci")
}
