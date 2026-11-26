package main

import (
	"context"
	"fmt"
	"os"
)

type releaseCIOptions struct {
	archive, digest, directory string
	createdAttempt             string
	created, recovery          bool
}

func runJetBrainsReleaseCI(root, operation string, metadata releaseMetadata, options releaseCIOptions) error {
	if metadata.TagObject == "" || metadata.Commit == "" || metadata.TagObject != os.Getenv("JETBRAINS_QUALIFIED_TAG_OBJECT") || metadata.Commit != os.Getenv("JETBRAINS_RELEASE_COMMIT") {
		return fmt.Errorf("remote annotated tag %s does not match the qualified tag object and commit", metadata.Tag)
	}
	ctx := context.Background()
	api := "https://api.github.com/repos/" + os.Getenv("GITHUB_REPOSITORY")
	attempt := os.Getenv("GITHUB_RUN_ATTEMPT")
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
		var createdAttempt string
		if created {
			createdAttempt = attempt
		}
		fmt.Printf("created=%t\ncreated-attempt=%s\n", created, createdAttempt)
		return nil
	case "sign":
		if err := requireJetBrainsReleaseAbsent(ctx, api, os.Getenv("GH_TOKEN"), metadata); err != nil {
			return err
		}
		return jetbrainsReleaseArtifact(ctx, root, operation, options.directory, options.archive, options.digest, metadata)
	case "verify-signed":
		return jetbrainsReleaseArtifact(ctx, root, operation, options.directory, options.archive, options.digest, metadata)
	case "github-require-absent":
		return requireJetBrainsReleaseAbsent(ctx, api, os.Getenv("GH_TOKEN"), metadata)
	case "github-state":
		action, err := jetbrainsGitHubState(ctx, api, os.Getenv("GH_TOKEN"), metadata)
		if err != nil {
			return err
		}
		fmt.Println(action)
		return nil
	case "github-assets":
		ids, err := jetbrainsPublishedAssetIDs(ctx, api, os.Getenv("GH_TOKEN"), metadata)
		if err != nil {
			return err
		}
		fmt.Printf("%d %d\n", ids[0], ids[1])
		return nil
	case "marketplace-policy":
		enablement, err := jetBrainsMarketplaceEnablement()
		if err != nil {
			return err
		}
		ok, message := marketplaceUploadPolicy(metadata, enablement, options.recovery, options.created, attempt, options.createdAttempt)
		fmt.Printf("upload=%t\nmessage=%s\n", ok, message)
		return nil
	case "marketplace-upload":
		return submitVerifiedJetBrainsArchive(ctx, root, api, marketplaceUploadURL, options.directory, options.digest, metadata)
	default:
		return fmt.Errorf("unknown JetBrains release operation %q", operation)
	}
}
