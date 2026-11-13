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
	if metadata.TagObject == "" || metadata.Commit == "" || metadata.TagObject != os.Getenv("JETBRAINS_QUALIFIED_TAG_OBJECT") || metadata.Commit != os.Getenv("JETBRAINS_RELEASE_COMMIT") {
		return fmt.Errorf("remote annotated tag %s does not match the qualified tag object and commit", metadata.Tag)
	}
	ctx := context.Background()
	api := "https://api.github.com/repos/" + os.Getenv("GITHUB_REPOSITORY")
	switch operation {
	case "check-tag":
		// metadataFromTag checked the remote annotation and HEAD before dispatch.
		return nil
	case "publish":
		if options.directory == "" {
			return fmt.Errorf("missing signed asset directory")
		}
		created, err := publishJetBrainsRelease(ctx, root, api, options.directory, options.digest, metadata)
		if err != nil {
			return err
		}
		fmt.Printf("created=%t\n", created)
		return nil
	case "sign", "verify-signed":
		return jetbrainsReleaseArtifact(ctx, root, operation, options.directory, options.archive, options.digest, metadata)
	case "github-state":
		action, err := jetbrainsGitHubState(ctx, api, os.Getenv("GH_TOKEN"), metadata)
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
		if err := requireRemoteTag(ctx, root, metadata); err != nil {
			return err
		}
		return uploadMarketplace(ctx, marketplaceUploadURL, os.Getenv("JETBRAINS_MARKETPLACE_TOKEN"), path)
	default:
		return fmt.Errorf("unknown JetBrains release operation %q", operation)
	}
}
