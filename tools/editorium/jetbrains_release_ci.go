package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

type releaseCIOptions struct {
	archive, digest, directory string
	created, recovery          bool
}

func runJetBrainsReleaseCI(root, operation string, metadata releaseMetadata, options releaseCIOptions) error {
	switch operation {
	case "sign", "verify-signed":
		return jetbrainsReleaseArtifact(context.Background(), root, operation, options.directory, options.archive, options.digest, metadata)
	case "github-state":
		action, err := jetbrainsGitHubState(context.Background(), "https://api.github.com/repos/"+os.Getenv("GITHUB_REPOSITORY"), os.Getenv("GH_TOKEN"), metadata)
		if err != nil {
			return err
		}
		fmt.Println(action)
		return nil
	case "marketplace-policy":
		enabled, err := envBool("JETBRAINS_MARKETPLACE_ENABLED")
		if err != nil {
			return err
		}
		ok, message := marketplaceUploadPolicy(metadata, enabled, options.recovery, options.created, os.Getenv("GITHUB_RUN_ATTEMPT"))
		fmt.Printf("upload=%t\nmessage=%s\n", ok, message)
		return nil
	case "marketplace-upload":
		if !metadata.MarketplaceEligible {
			return fmt.Errorf("%s is ineligible for Marketplace", metadata.Version)
		}
		if options.directory == "" {
			return fmt.Errorf("missing signed asset directory")
		}
		dir := options.directory
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(root, dir)
		}
		path := filepath.Join(dir, metadata.Assets[0])
		actual, err := sha256File(path)
		if err != nil {
			return err
		}
		if options.digest != actual {
			return fmt.Errorf("Marketplace ZIP differs from verified SHA-256")
		}
		return uploadMarketplace(context.Background(), marketplaceUploadURL, os.Getenv("JETBRAINS_MARKETPLACE_TOKEN"), path)
	default:
		return fmt.Errorf("unknown JetBrains release operation %q", operation)
	}
}
