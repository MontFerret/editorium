package main

import (
	"context"
	"fmt"
)

type releaseDescription struct {
	runCI           func(string, string, releaseMetadata, releaseCIOptions) error
	versionSource   string
	title           string
	readVersion     func(string) (string, error)
	assets          func(string) []string
	qualify         func(context.Context, string, []string) error
	testEnvironment []string
	replaceDraft    bool
	checkTagCommit  bool
}

func describeRelease(extension string) (releaseDescription, error) {
	switch extension {
	case "vscode":
		return releaseDescription{
			versionSource: "extensions/vscode/package.json",
			title:         "Ferret VS Code",
			readVersion: func(root string) (string, error) {
				manifest, err := readVSCodeManifest(root)
				return manifest.Version, err
			},
			assets:       vscodeReleaseAssetNames,
			replaceDraft: true,
			qualify: func(ctx context.Context, root string, _ []string) error {
				return runExtensions(ctx, root, "test", []string{"vscode"})
			},
		}, nil
	case "jetbrains":
		return releaseDescription{
			runCI:           runJetBrainsReleaseCI,
			versionSource:   jetbrainsVersionSource,
			title:           "Ferret JetBrains",
			readVersion:     jetbrainsPluginVersion,
			assets:          jetbrainsReleaseAssetNames,
			checkTagCommit:  true,
			qualify:         testJetBrains,
			testEnvironment: []string{"FERRET_TEST_PASSIVE_HOST_LOSS=1"},
		}, nil
	default:
		return releaseDescription{}, fmt.Errorf("unknown release integration %q", extension)
	}
}
