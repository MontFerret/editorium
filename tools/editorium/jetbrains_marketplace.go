package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const marketplaceUploadURL = "https://plugins.jetbrains.com/api/updates/upload"

type marketplaceEnablement int

const (
	marketplaceSetupPending marketplaceEnablement = iota
	marketplaceDisabled
	marketplaceEnabled
)

func jetBrainsMarketplaceEnablement() (marketplaceEnablement, error) {
	const name = "JB_MARKETPLACE_ENABLED"
	if strings.TrimSpace(os.Getenv(name)) == "" {
		return marketplaceSetupPending, nil
	}
	enabled, err := envBool(name)
	if enabled {
		return marketplaceEnabled, nil
	}
	return marketplaceDisabled, err
}

func submitVerifiedJetBrainsArchive(ctx context.Context, root, api, endpoint, dir, digest string, m releaseMetadata) error {
	if !m.MarketplaceEligible {
		return fmt.Errorf("%s is ineligible for Marketplace", m.Version)
	}
	if dir == "" {
		return fmt.Errorf("missing signed asset directory")
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	path := filepath.Join(dir, m.Assets[0])
	actual, err := sha256File(path)
	if err != nil {
		return err
	}
	if digest != actual {
		return fmt.Errorf("Marketplace ZIP differs from verified SHA-256")
	}
	if _, err := requireJetBrainsPublishedRelease(ctx, api, os.Getenv("GH_TOKEN"), m); err != nil {
		return err
	}
	if err := requireRemoteTag(ctx, root, m); err != nil {
		return err
	}
	return uploadMarketplace(ctx, endpoint, os.Getenv("JB_MARKETPLACE_TOKEN"), path)
}

func uploadMarketplace(ctx context.Context, endpoint, token, archive string) error {
	if token == "" {
		return fmt.Errorf("missing JB_MARKETPLACE_TOKEN")
	}
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	// Stream the selected file between the multipart headers and closing boundary.
	var header bytes.Buffer
	form := multipart.NewWriter(&header)
	if err := form.WriteField("xmlId", jetbrainsPluginID); err != nil {
		return err
	}
	if _, err := form.CreateFormFile("file", filepath.Base(archive)); err != nil {
		return err
	}
	headerSize := header.Len()
	if err := form.Close(); err != nil {
		return err
	}
	body := io.MultiReader(bytes.NewReader(header.Bytes()[:headerSize]), file, bytes.NewReader(header.Bytes()[headerSize:]))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	req.ContentLength = int64(header.Len()) + info.Size()
	client := http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Marketplace submission outcome unknown: %w; inspect the vendor dashboard before recovery", err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		fmt.Println("Marketplace accepted the submission. Review and public visibility are pending.")
		return nil
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return fmt.Errorf("Marketplace authentication or vendor permission failed (HTTP %d); check the protected environment token", res.StatusCode)
	default:
		return fmt.Errorf("Marketplace upload returned HTTP %d; inspect the vendor dashboard for an existing or pending version before recovery", res.StatusCode)
	}
}

func marketplaceUploadPolicy(m releaseMetadata, enablement marketplaceEnablement, recovery, created bool, attempt, createdAttempt string) (bool, string) {
	switch {
	case m.Prerelease:
		return false, "GitHub-only prerelease. Marketplace updates require an exact stable major.minor.patch version."
	case !m.MarketplaceEligible:
		return false, "GitHub-only version. Marketplace updates require an exact stable major.minor.patch version."
	case enablement == marketplaceSetupPending:
		return false, "Initial Marketplace listing setup required before enabling uploads. Check the Ferret (ferretlang) vendor dashboard, complete the first listing if needed, then configure JB_MARKETPLACE_TOKEN and set JB_MARKETPLACE_ENABLED=true."
	case enablement == marketplaceDisabled:
		return false, "Marketplace publication disabled by JB_MARKETPLACE_ENABLED. Enable it after confirming the initial listing, then follow the explicit recovery procedure for this version."
	case recovery && attempt == "1":
		return true, ""
	case !recovery && created && attempt != "" && attempt == createdAttempt:
		return true, ""
	default:
		return false, "Marketplace submission skipped. Explicit recovery required. Check the Ferret vendor dashboard for this version and start a fresh dispatch with confirm-absent=true only if the version is absent from both pending and published updates."
	}
}
