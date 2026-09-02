package main

import (
	"fmt"
	"strings"
)

type ferretdTarget struct {
	ID           string
	Platform     string
	Architecture string
	GoOS         string
	GoArch       string
	Artifact     string
	ArchiveType  string
	BinaryName   string
	Unix         bool
}

var ferretdTargets = []ferretdTarget{
	{ID: "darwin-arm64", Platform: "darwin", Architecture: "arm64", GoOS: "darwin", GoArch: "arm64", Artifact: "ferretd_darwin_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
	{ID: "darwin-x64", Platform: "darwin", Architecture: "x64", GoOS: "darwin", GoArch: "amd64", Artifact: "ferretd_darwin_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
	{ID: "linux-arm64", Platform: "linux", Architecture: "arm64", GoOS: "linux", GoArch: "arm64", Artifact: "ferretd_linux_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
	{ID: "linux-x64", Platform: "linux", Architecture: "x64", GoOS: "linux", GoArch: "amd64", Artifact: "ferretd_linux_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
	{ID: "win32-arm64", Platform: "win32", Architecture: "arm64", GoOS: "windows", GoArch: "arm64", Artifact: "ferretd_windows_arm64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Unix: false},
	{ID: "win32-x64", Platform: "win32", Architecture: "x64", GoOS: "windows", GoArch: "amd64", Artifact: "ferretd_windows_x86_64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Unix: false},
}

func resolveFerretdTarget(id string) (ferretdTarget, error) {
	for _, target := range ferretdTargets {
		if target.ID == id {
			return target, nil
		}
	}

	return ferretdTarget{}, fmt.Errorf("unsupported ferretd target %s; supported targets: %s", id, strings.Join(ferretdTargetIDs(), ", "))
}

func detectHostFerretdTarget(goos, goarch string) (ferretdTarget, error) {
	for _, target := range ferretdTargets {
		if target.GoOS == goos && target.GoArch == goarch {
			return target, nil
		}
	}

	return ferretdTarget{}, fmt.Errorf("unsupported host platform %s-%s; supported ferretd targets: %s", goos, goarch, strings.Join(ferretdTargetIDs(), ", "))
}

func ferretdTargetIDs() []string {
	ids := make([]string, 0, len(ferretdTargets))

	for _, target := range ferretdTargets {
		ids = append(ids, target.ID)
	}

	return ids
}
