package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

const marketplaceMaxBytes = 400_000_000

func jetbrainsReleaseArtifact(ctx context.Context, root, operation, directory, unsigned, digest string, m releaseMetadata) error {
	if directory == "" {
		return fmt.Errorf("missing --directory for signed assets")
	}
	if !filepath.IsAbs(directory) {
		directory = filepath.Join(root, directory)
	}
	signed := filepath.Join(directory, m.Assets[0])
	certificate := os.Getenv("JETBRAINS_CERTIFICATE_FILE")
	if !filepath.IsAbs(certificate) || !regularFile(certificate) {
		return fmt.Errorf("JETBRAINS_CERTIFICATE_FILE must name the trusted certificate file")
	}
	if operation == "sign" {
		key := os.Getenv("JETBRAINS_SIGNING_KEY_FILE")
		if !filepath.IsAbs(key) || !regularFile(key) {
			return fmt.Errorf("JETBRAINS_SIGNING_KEY_FILE must name the signing key file")
		}
		if !filepath.IsAbs(unsigned) {
			return fmt.Errorf("--archive must name the absolute unsigned ZIP")
		}
		if filepath.Base(unsigned) != jetbrainsArchiveRoot+"-"+m.Version+".zip" || filepath.Clean(filepath.Dir(unsigned)) == filepath.Clean(directory) {
			return fmt.Errorf("select the unsigned versioned archive and a separate signed output directory")
		}
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
		files, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		if len(files) != 0 {
			return fmt.Errorf("signing requires an empty output directory: %s", directory)
		}
		actual, err := sha256File(unsigned)
		if err != nil {
			return err
		}
		if actual != digest {
			return fmt.Errorf("unsigned ZIP checksum mismatch: expected %s, got %s", digest, actual)
		}
		if err := checkJetBrainsArtifact(ctx, root, unsigned, m.Version, m.Commit); err != nil {
			return err
		}
		if err := runJetBrainsSigner(ctx, root, "signPlugin", unsigned, signed); err != nil {
			return err
		}
	}
	if !regularFile(signed) {
		return fmt.Errorf("missing signed ZIP: %s", signed)
	}
	if err := checkMarketplaceSize(signed); err != nil {
		return err
	}
	if err := runJetBrainsSigner(ctx, root, "verifyPluginSignature", "", signed); err != nil {
		return err
	}
	if err := checkJetBrainsArtifact(ctx, root, signed, m.Version, m.Commit); err != nil {
		return err
	}
	sum, err := sha256File(signed)
	if err != nil {
		return err
	}
	line := sum + "  " + m.Assets[0] + "\n"
	if operation == "sign" {
		if err := writeFileAtomic(signed+".sha256", []byte(line), 0o644); err != nil {
			return err
		}
	}
	if _, err := validateReleaseAssets(directory, m.Assets); err != nil {
		return err
	}
	checksum, err := os.ReadFile(signed + ".sha256")
	if err != nil {
		return err
	}
	if string(checksum) != line {
		return fmt.Errorf("published checksum conflicts with %s; inspect the original release assets", m.Assets[0])
	}
	fmt.Printf("Verified signed release %s at %s, SHA-256 %s\n", m.Tag, m.Commit, sum)
	return nil
}

func runJetBrainsSigner(ctx context.Context, root, task, input, output string) error {
	environment := []string{"JETBRAINS_SIGNED_ZIP=" + output}
	if input != "" {
		environment = append(environment, "JETBRAINS_UNSIGNED_ZIP="+input)
	}
	return runJetBrainsGradleEnvironment(ctx, root, environment, task, "--no-configuration-cache", "--no-build-cache", "--rerun-tasks", "--quiet")
}

func checkMarketplaceSize(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > marketplaceMaxBytes {
		return fmt.Errorf("signed ZIP measures %d bytes, exceeding the %d-byte Marketplace limit for the universal plugin", info.Size(), marketplaceMaxBytes)
	}
	fmt.Printf("Signed ZIP size: %d bytes\n", info.Size())
	return nil
}
