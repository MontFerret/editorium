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
	"time"
)

const marketplaceUploadURL = "https://plugins.jetbrains.com/api/updates/upload"

func uploadMarketplace(ctx context.Context, endpoint, token, archive string) error {
	if token == "" {
		return fmt.Errorf("missing JETBRAINS_MARKETPLACE_TOKEN")
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

func marketplaceUploadPolicy(m releaseMetadata, enabled bool, recovery, created bool, attempt string) (bool, string) {
	switch {
	case !m.MarketplaceEligible:
		return false, "This plugin version is GitHub-only. Stable requires an exact major.minor.patch."
	case !enabled:
		return false, "Marketplace bootstrap required. Complete the packaged smoke and manually submit the signed GitHub ZIP."
	case attempt != "1" || (!recovery && !created):
		return false, "Original GitHub assets verified. Check the vendor dashboard before an explicit Marketplace recovery dispatch."
	default:
		return true, ""
	}
}
