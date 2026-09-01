package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/mod/semver"
)

const (
	ferretdRepository = "MontFerret/ferretd"
	checksumAsset     = "ferretd_checksums.txt"
	maximumBinarySize = 128 * 1024 * 1024
)

var checksumLinePattern = regexp.MustCompile(`^([0-9a-f]{64})  ([^/\\]+)$`)

type (
	httpDoer interface {
		Do(*http.Request) (*http.Response, error)
	}

	acquiredFerretd struct {
		ArchivePath string
		BinaryPath  string
		Digest      string
		Version     string
	}
)

func readFerretdVersion(root string) (string, error) {
	path := filepath.Join(root, "ferretd.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}

	decoder := json.NewDecoder(bytes.NewReader(contents))
	opening, err := decoder.Token()
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}

	if opening != json.Delim('{') {
		return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
	}

	var value json.RawMessage
	keys := 0
	seen := make(map[string]struct{})
	for decoder.More() {
		keyToken, tokenErr := decoder.Token()
		if tokenErr != nil {
			return "", fmt.Errorf("cannot read %s: %w", path, tokenErr)
		}

		key, ok := keyToken.(string)
		if !ok {
			return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
		}

		if _, duplicate := seen[key]; duplicate {
			return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
		}

		seen[key] = struct{}{}
		keys++

		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return "", fmt.Errorf("cannot read %s: %w", path, err)
		}

		if key == "ferretd" {
			value = raw
		}
	}

	closing, err := decoder.Token()
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}

	if closing != json.Delim('}') {
		return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
	}

	if trailingErr := decoder.Decode(new(any)); trailingErr != io.EOF {
		return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
	}

	if keys != 1 || value == nil {
		return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
	}

	var version string
	if err := json.Unmarshal(value, &version); err != nil || !validVersion(version) {
		return "", fmt.Errorf("%s must contain exactly one valid \"ferretd\" version", path)
	}

	return version, nil
}

func validVersion(version string) bool {
	return version != "" && semver.IsValid("v"+version)
}

func releaseAssetURL(version, asset string) (string, error) {
	if !validVersion(version) {
		return "", fmt.Errorf("invalid ferretd version: %s", version)
	}

	if matched, _ := regexp.MatchString(`^[0-9A-Za-z._-]+$`, asset); !matched {
		return "", fmt.Errorf("invalid ferretd release asset: %s", asset)
	}

	return fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", ferretdRepository, version, asset), nil
}

func sourceArchiveURL(version string) (string, error) {
	if !validVersion(version) {
		return "", fmt.Errorf("invalid ferretd version: %s", version)
	}

	return fmt.Sprintf("https://github.com/%s/archive/refs/tags/v%s.tar.gz", ferretdRepository, version), nil
}

func parseChecksums(contents string) (map[string]string, error) {
	result := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(contents))
	line := 0

	for scanner.Scan() {
		line++
		raw := strings.TrimSuffix(scanner.Text(), "\r")
		if raw == "" {
			continue
		}

		matches := checksumLinePattern.FindStringSubmatch(raw)
		if matches == nil {
			return nil, fmt.Errorf("invalid checksum line %d", line)
		}

		if _, exists := result[matches[2]]; exists {
			return nil, fmt.Errorf("duplicate checksum entry for %s", matches[2])
		}

		result[matches[2]] = matches[1]
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("checksum manifest is empty")
	}

	return result, nil
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}

	defer file.Close()

	hash := sha256.New()

	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

func acquireFerretd(ctx context.Context, root string, target ferretdTarget, client httpDoer) (acquiredFerretd, error) {
	if client == nil {
		client = http.DefaultClient
	}

	version, err := readFerretdVersion(root)
	if err != nil {
		return acquiredFerretd{}, err
	}

	cacheRoot := filepath.Join(root, ".dist", "ferretd", version, target.ID)
	if err := os.MkdirAll(cacheRoot, 0o755); err != nil {
		return acquiredFerretd{}, err
	}

	checksumPath := filepath.Join(cacheRoot, checksumAsset)
	if !regularFile(checksumPath) {
		url, urlErr := releaseAssetURL(version, checksumAsset)
		if urlErr != nil {
			return acquiredFerretd{}, urlErr
		}

		if err := downloadFile(ctx, client, url, checksumPath); err != nil {
			return acquiredFerretd{}, err
		}
	}

	checksumContents, err := os.ReadFile(checksumPath)
	if err != nil {
		return acquiredFerretd{}, err
	}

	checksums, err := parseChecksums(string(checksumContents))
	if err != nil {
		return acquiredFerretd{}, err
	}

	expected, ok := checksums[target.Artifact]
	if !ok {
		return acquiredFerretd{}, fmt.Errorf("%s does not contain %s for %s", checksumAsset, target.Artifact, target.ID)
	}

	archivePath := filepath.Join(cacheRoot, target.Artifact)
	if !regularFile(archivePath) {
		url, urlErr := releaseAssetURL(version, target.Artifact)
		if urlErr != nil {
			return acquiredFerretd{}, urlErr
		}

		if err := downloadFile(ctx, client, url, archivePath); err != nil {
			return acquiredFerretd{}, err
		}
	}

	actual, err := sha256File(archivePath)
	if err != nil {
		return acquiredFerretd{}, err
	}

	if actual != expected {
		_ = os.Remove(archivePath)

		return acquiredFerretd{}, fmt.Errorf("checksum mismatch for %s: expected %s, got %s", target.Artifact, expected, actual)
	}

	contents, err := extractBinary(archivePath, target)
	if err != nil {
		return acquiredFerretd{}, err
	}

	mode := os.FileMode(0o644)
	if target.Unix {
		mode = 0o755
	}

	binaryPath := filepath.Join(cacheRoot, "extracted", target.BinaryName)
	if err := writeFileAtomic(binaryPath, contents, mode); err != nil {
		return acquiredFerretd{}, err
	}

	return acquiredFerretd{ArchivePath: archivePath, BinaryPath: binaryPath, Digest: actual, Version: version}, nil
}

func downloadFile(ctx context.Context, client httpDoer, url, destination string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("cannot download %s: %w", url, err)
	}

	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("cannot download %s: HTTP %s", url, response.Status)
	}

	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}

	temporary, err := os.CreateTemp(filepath.Dir(destination), filepath.Base(destination)+".partial-")
	if err != nil {
		return err
	}

	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if _, err := io.Copy(temporary, response.Body); err != nil {
		temporary.Close()
		return fmt.Errorf("cannot download %s: %w", url, err)
	}

	if err := temporary.Close(); err != nil {
		return err
	}

	if err := replaceFile(temporaryPath, destination); err != nil {
		return err
	}

	return nil
}

func extractBinary(path string, target ferretdTarget) ([]byte, error) {
	switch target.ArchiveType {
	case "tar.gz":
		return extractTarBinary(path, target.BinaryName)
	case "zip":
		return extractZipBinary(path, target.BinaryName)
	default:
		return nil, fmt.Errorf("unsupported archive type: %s", target.ArchiveType)
	}
}

func extractTarBinary(path, binaryName string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	defer file.Close()

	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return nil, fmt.Errorf("cannot extract %s: %w", path, err)
	}

	defer gzipReader.Close()

	reader := tar.NewReader(gzipReader)
	var binary []byte
	for {
		header, nextErr := reader.Next()
		if nextErr == io.EOF {
			break
		}

		if nextErr != nil {
			return nil, fmt.Errorf("cannot extract %s: %w", path, nextErr)
		}

		if header.Name != binaryName {
			continue
		}

		if binary != nil {
			return nil, fmt.Errorf("archive contains duplicate %s", binaryName)
		}

		if header.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%s is not a regular file", binaryName)
		}

		var buffer bytes.Buffer
		if err := copyLimited(&buffer, reader, maximumBinarySize, binaryName); err != nil {
			return nil, err
		}

		binary = buffer.Bytes()
	}

	if binary == nil {
		return nil, fmt.Errorf("%s does not contain %s", path, binaryName)
	}

	return binary, nil
}

func extractZipBinary(path, binaryName string) ([]byte, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("cannot extract %s: %w", path, err)
	}

	defer archive.Close()

	var binary []byte
	for _, file := range archive.File {
		if file.Name != binaryName {
			continue
		}

		if binary != nil {
			return nil, fmt.Errorf("archive contains duplicate %s", binaryName)
		}

		if file.FileInfo().IsDir() || !file.Mode().IsRegular() || file.UncompressedSize64 > maximumBinarySize {
			return nil, fmt.Errorf("%s is not a bounded regular file", binaryName)
		}

		reader, openErr := file.Open()
		if openErr != nil {
			return nil, openErr
		}

		var buffer bytes.Buffer
		copyErr := copyLimited(&buffer, reader, maximumBinarySize, binaryName)
		closeErr := reader.Close()

		if copyErr != nil {
			return nil, copyErr
		}

		if closeErr != nil {
			return nil, closeErr
		}

		binary = buffer.Bytes()
	}

	if binary == nil {
		return nil, fmt.Errorf("%s does not contain %s", path, binaryName)
	}

	return binary, nil
}

func writeFileAtomic(destination string, contents []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}

	temporary, err := os.CreateTemp(filepath.Dir(destination), filepath.Base(destination)+".partial-")
	if err != nil {
		return err
	}

	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()

		return err
	}

	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()

		return err
	}

	if err := temporary.Close(); err != nil {
		return err
	}

	return replaceFile(temporaryPath, destination)
}

func copyFileAtomic(source, destination string, mode os.FileMode) error {
	contents, err := os.ReadFile(source)
	if err != nil {
		return err
	}

	return writeFileAtomic(destination, contents, mode)
}

func replaceFile(source, destination string) error {
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return err
	}

	return os.Rename(source, destination)
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)

	return err == nil && info.Mode().IsRegular()
}
