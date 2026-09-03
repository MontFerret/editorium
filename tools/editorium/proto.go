package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maximumProtoArchiveSize = 64 * 1024 * 1024
	maximumExpandedSize     = 256 * 1024 * 1024
	maximumProtoFileSize    = 4 * 1024 * 1024
	maximumProtoTreeSize    = 32 * 1024 * 1024
	protoVersionMarker      = ".ferretd-version"
)

var requiredSchemas = []string{
	"daemon/v1/daemon.proto",
	"execution/v1/execution.proto",
	"workspace/v1/workspace.proto",
}

type protoSyncResult struct {
	Updated bool
	Version string
}

type protoGenerator func(context.Context, string, bool) error

func runProtoCommand(ctx context.Context, root string, args []string) error {
	if len(args) == 0 {
		return usageError("proto requires sync, generate, or check")
	}

	switch args[0] {
	case "sync":
		if len(args) != 1 {
			return usageError("proto sync accepts no integration")
		}

		force, err := envBool("FORCE")
		if err != nil {
			return err
		}

		result, err := syncFerretdProto(ctx, root, force, http.DefaultClient)
		if err != nil {
			return err
		}

		if result.Updated {
			fmt.Printf("Synchronized ferretd %s protocol schemas.\n", result.Version)
		} else {
			fmt.Printf("ferretd %s protocol schemas are already current.\n", result.Version)
		}

		return nil
	case "generate", "check":
		if len(args) != 2 {
			return usageError(fmt.Sprintf("proto %s requires exactly one extension", args[0]))
		}

		if err := validateExtensions(args[1:]); err != nil {
			return err
		}

		generator, err := protoGeneratorForExtension(args[1])
		if err != nil {
			return err
		}

		_, err = syncFerretdProto(ctx, root, false, http.DefaultClient)
		if err != nil {
			return err
		}

		return generator(ctx, root, args[0] == "check")
	default:
		return usageError(fmt.Sprintf("unknown proto operation %q", args[0]))
	}
}

func protoGeneratorForExtension(extension string) (protoGenerator, error) {
	switch extension {
	case "vscode":
		return generateVSCodeProto, nil
	case "jetbrains":
		return generateJetBrainsProto, nil
	default:
		return nil, fmt.Errorf("extension %q does not implement protobuf generation", extension)
	}
}

func syncFerretdProto(ctx context.Context, root string, force bool, client httpDoer) (protoSyncResult, error) {
	if client == nil {
		client = http.DefaultClient
	}

	version, err := readFerretdVersion(root)
	if err != nil {
		return protoSyncResult{}, err
	}

	sharedRoot := filepath.Join(root, "shared", "proto")
	managedRoot := filepath.Join(sharedRoot, "ferretd")

	if !force {
		matches, matchErr := schemasMatch(managedRoot, version)
		if matchErr != nil {
			return protoSyncResult{}, matchErr
		}

		if matches {
			return protoSyncResult{Updated: false, Version: version}, nil
		}
	}

	if err := os.MkdirAll(sharedRoot, 0o755); err != nil {
		return protoSyncResult{}, err
	}

	stagingRoot, err := os.MkdirTemp(sharedRoot, ".ferretd-stage-")
	if err != nil {
		return protoSyncResult{}, err
	}

	defer os.RemoveAll(stagingRoot)

	if err := downloadAndExtractProto(ctx, client, version, stagingRoot); err != nil {
		return protoSyncResult{}, err
	}

	if err := validateRequiredSchemas(stagingRoot); err != nil {
		return protoSyncResult{}, err
	}

	if err := os.WriteFile(filepath.Join(stagingRoot, protoVersionMarker), []byte(version+"\n"), 0o644); err != nil {
		return protoSyncResult{}, err
	}

	if err := replaceDirectoryAtomic(stagingRoot, managedRoot); err != nil {
		return protoSyncResult{}, err
	}

	return protoSyncResult{Updated: true, Version: version}, nil
}

func schemasMatch(root, version string) (bool, error) {
	marker, err := os.ReadFile(filepath.Join(root, protoVersionMarker))
	if os.IsNotExist(err) {
		return false, nil
	}

	if err != nil {
		return false, err
	}

	if string(marker) != version+"\n" {
		return false, nil
	}

	if err := validateRequiredSchemas(root); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}

		return false, err
	}

	return true, nil
}

func downloadAndExtractProto(ctx context.Context, client httpDoer, version, destination string) error {
	url, err := sourceArchiveURL(version)
	if err != nil {
		return err
	}

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

	var compressed bytes.Buffer
	if err := copyLimited(&compressed, response.Body, maximumProtoArchiveSize, "source archive"); err != nil {
		return fmt.Errorf("cannot extract %s: %w", url, err)
	}

	gzipReader, err := gzip.NewReader(bytes.NewReader(compressed.Bytes()))
	if err != nil {
		return fmt.Errorf("cannot extract %s: %w", url, err)
	}

	defer gzipReader.Close()

	var expanded bytes.Buffer
	if err := copyLimited(&expanded, gzipReader, maximumExpandedSize, "expanded source archive"); err != nil {
		return fmt.Errorf("cannot extract %s: %w", url, err)
	}

	reader := tar.NewReader(bytes.NewReader(expanded.Bytes()))
	files := make(map[string]struct{})

	var archiveRoot string
	var total int64

	for {
		header, nextErr := reader.Next()
		if nextErr == io.EOF {
			break
		}

		if nextErr != nil {
			return fmt.Errorf("cannot extract %s: %w", url, nextErr)
		}

		relative, selected, pathErr := protoArchivePath(header.Name)
		if pathErr != nil {
			return pathErr
		}

		if !selected {
			continue
		}

		rootPart := strings.Split(header.Name, "/")[0]
		if archiveRoot == "" {
			archiveRoot = rootPart
		} else if archiveRoot != rootPart {
			return fmt.Errorf("archive contains multiple source roots")
		}

		if header.Typeflag != tar.TypeReg {
			return fmt.Errorf("schema archive entry is not a regular file: %s", header.Name)
		}

		if _, duplicate := files[relative]; duplicate {
			return fmt.Errorf("schema archive contains duplicate %s", relative)
		}

		if header.Size > maximumProtoFileSize {
			return fmt.Errorf("%s exceeds the file size limit", relative)
		}

		if total+header.Size > maximumProtoTreeSize {
			return fmt.Errorf("schema archive exceeds the total size limit")
		}

		files[relative] = struct{}{}
		total += header.Size
		output := filepath.Join(destination, filepath.FromSlash(relative))

		if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
			return err
		}

		contents := make([]byte, header.Size)

		if _, err := io.ReadFull(reader, contents); err != nil {
			return fmt.Errorf("cannot extract %s: %w", url, err)
		}

		if err := os.WriteFile(output, contents, 0o644); err != nil {
			return err
		}
	}

	if len(files) == 0 {
		return fmt.Errorf("%s does not contain proto/ferretd schemas", url)
	}

	return nil
}

func protoArchivePath(name string) (string, bool, error) {
	if strings.HasPrefix(name, "/") || strings.Contains(name, "\\") {
		return "", false, fmt.Errorf("unsafe schema archive path: %s", name)
	}

	parts := strings.Split(name, "/")
	if len(parts) == 0 || !safeArchivePart(parts[0]) {
		return "", false, fmt.Errorf("unsafe schema archive path: %s", name)
	}

	for _, part := range parts {
		if part == ".." || part == "." {
			return "", false, fmt.Errorf("unsafe schema archive path: %s", name)
		}
	}

	if len(parts) < 4 || parts[1] != "proto" || parts[2] != "ferretd" {
		return "", false, nil
	}

	if parts[len(parts)-1] == "" {
		return "", false, nil
	}

	relativeParts := parts[3:]
	if len(relativeParts) == 0 {
		return "", false, fmt.Errorf("unsafe schema archive path: %s", name)
	}

	for _, part := range relativeParts {
		if !safeArchivePart(part) {
			return "", false, fmt.Errorf("unsafe schema archive path: %s", name)
		}
	}

	relative := strings.Join(relativeParts, "/")
	if !strings.HasSuffix(relative, ".proto") {
		return "", false, nil
	}

	return relative, true, nil
}

func safeArchivePart(part string) bool {
	if part == "" || part == "." || part == ".." {
		return false
	}

	for _, character := range part {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.ContainsRune("._-", character) {

			continue
		}

		return false
	}

	return true
}

func validateRequiredSchemas(root string) error {
	for _, schema := range requiredSchemas {
		path := filepath.Join(root, filepath.FromSlash(schema))
		info, err := os.Lstat(path)
		if err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("missing required ferretd schema: %s: %w", schema, err)
			}

			return err
		}

		if !info.Mode().IsRegular() {
			return fmt.Errorf("required ferretd schema is not a file: %s", schema)
		}
	}

	return nil
}

func replaceDirectoryAtomic(source, destination string) error {
	backupRoot, err := os.MkdirTemp(filepath.Dir(destination), "."+filepath.Base(destination)+".backup-")
	if err != nil {
		return err
	}

	if err := os.Remove(backupRoot); err != nil {
		return err
	}

	backup := backupRoot
	hadDestination := false

	if info, statErr := os.Stat(destination); statErr == nil && info.IsDir() {
		hadDestination = true

		if err := os.Rename(destination, backup); err != nil {
			return err
		}
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}

	if err := os.Rename(source, destination); err != nil {
		if hadDestination {
			if restoreErr := os.Rename(backup, destination); restoreErr != nil {
				return fmt.Errorf("cannot replace %s (%v) or restore its previous contents (%v)", destination, err, restoreErr)
			}
		}

		return err
	}

	if hadDestination {
		if err := os.RemoveAll(backup); err != nil {
			return err
		}
	}

	return nil
}

func generateVSCodeProto(ctx context.Context, root string, check bool) error {
	packageRoot := vscodePackageRoot(root)
	generatedRoot := filepath.Join(packageRoot, "src", "daemon", "gen")
	buf := filepath.Join(packageRoot, "node_modules", ".bin", executableName("buf"))
	outputRoot := generatedRoot

	if check {
		temporary, err := os.MkdirTemp("", "ferret-vscode-proto-")
		if err != nil {
			return err
		}

		defer os.RemoveAll(temporary)

		outputRoot = temporary
		if err := runCommand(ctx, root, nodeBinEnvironment(packageRoot), buf, "lint", "shared/proto", "--config", "buf.yaml"); err != nil {
			return err
		}
	}

	template := map[string]any{
		"version": "v2",
		"clean":   true,
		"inputs": []any{map[string]any{
			"directory": root,
			"paths": []string{
				"shared/proto/ferretd/daemon/v1/daemon.proto",
				"shared/proto/ferretd/execution/v1/execution.proto",
				"shared/proto/ferretd/workspace/v1/workspace.proto",
				"shared/proto/google/rpc/status.proto",
			},
		}},
		"plugins": []any{map[string]any{
			"local":    "protoc-gen-ts_proto",
			"out":      outputRoot,
			"strategy": "all",
			"opt": []string{
				"env=node", "esModuleInterop=false", "fileSuffix=.pb", "forceLong=number",
				"oneof=unions", "outputClientImpl=false", "outputJsonMethods=false",
				"outputServices=grpc-js", "useExactTypes=false", "useOptionals=messages",
			},
		}},
	}

	templateJSON, err := json.Marshal(template)
	if err != nil {
		return err
	}

	if err := runCommand(ctx, root, nodeBinEnvironment(packageRoot), buf, "generate", "--template", string(templateJSON)); err != nil {
		return err
	}

	if check {
		return compareTrees(generatedRoot, outputRoot)
	}

	return nil
}

func compareTrees(expectedRoot, actualRoot string) error {
	expected, err := treeFiles(expectedRoot)
	if err != nil {
		return err
	}

	actual, err := treeFiles(actualRoot)
	if err != nil {
		return err
	}

	names := make(map[string]struct{})
	for name := range expected {
		names[name] = struct{}{}
	}

	for name := range actual {
		names[name] = struct{}{}
	}

	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}

	sort.Strings(ordered)

	var differences []string
	for _, name := range ordered {
		expectedPath, expectedOK := expected[name]
		actualPath, actualOK := actual[name]

		switch {
		case !expectedOK:
			differences = append(differences, "unexpected generated file: "+name)
		case !actualOK:
			differences = append(differences, "missing generated file: "+name)
		default:
			expectedBytes, readErr := os.ReadFile(expectedPath)
			if readErr != nil {
				return readErr
			}

			actualBytes, readErr := os.ReadFile(actualPath)
			if readErr != nil {
				return readErr
			}

			if !bytes.Equal(expectedBytes, actualBytes) {
				differences = append(differences, "outdated generated file: "+name)
			}
		}
	}

	if len(differences) > 0 {
		return fmt.Errorf("generated protobuf sources are out of date:\n%s", strings.Join(differences, "\n"))
	}

	return nil
}

func treeFiles(root string) (map[string]string, error) {
	result := make(map[string]string)

	if _, err := os.Stat(root); os.IsNotExist(err) {
		return result, nil
	}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if entry.Type().IsRegular() {
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}

			result[filepath.ToSlash(relative)] = path
		}

		return nil
	})

	return result, err
}
