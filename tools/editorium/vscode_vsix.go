package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"slices"
)

type vsixManifest struct {
	XMLName  xml.Name `xml:"PackageManifest"`
	Metadata []struct {
		Identities []struct {
			Name      string `xml:"Id,attr"`
			Publisher string `xml:"Publisher,attr"`
			Version   string `xml:"Version,attr"`
			Target    string `xml:"TargetPlatform,attr"`
		} `xml:"Identity"`
		Properties []struct {
			ID string `xml:"Id,attr"`
		} `xml:"Properties>Property"`
	} `xml:"Metadata"`
}

func inspectVSIX(archive *zip.Reader, target vscodeTarget, releaseTarget ferretdTarget, manifest vscodeManifest, stable bool) (*zip.File, error) {
	binaryEntry := "extension/bin/" + releaseTarget.BinaryName
	expected := []string{
		"[Content_Types].xml", "extension.vsixmanifest", "extension/LICENSE.txt", binaryEntry,
		"extension/language-configuration.json", "extension/out/extension.js", "extension/package.json",
		"extension/readme.md", "extension/media/icon.png", "extension/syntaxes/ferret.tmLanguage.json",
	}
	entries := make(map[string]*zip.File, len(expected))
	actual := make([]string, 0, len(archive.File))
	for _, file := range archive.File {
		if _, duplicate := entries[file.Name]; duplicate {
			return nil, fmt.Errorf("duplicate VSIX entry: %s", file.Name)
		}
		if file.UncompressedSize64 > maximumVSIXEntrySize || !file.Mode().IsRegular() {
			return nil, fmt.Errorf("VSIX entry is not a bounded regular file: %s", file.Name)
		}
		entries[file.Name] = file
		actual = append(actual, file.Name)
	}
	slices.Sort(actual)
	slices.Sort(expected)
	if !slices.Equal(actual, expected) {
		return nil, fmt.Errorf("unexpected VSIX contents: got %v, want %v", actual, expected)
	}

	manifestBytes, err := readZipEntry(entries["extension.vsixmanifest"])
	if err != nil {
		return nil, err
	}
	var packagedVSIX vsixManifest
	if err := xml.Unmarshal(manifestBytes, &packagedVSIX); err != nil {
		return nil, fmt.Errorf("read VSIX manifest: %w", err)
	}
	if len(packagedVSIX.Metadata) != 1 || len(packagedVSIX.Metadata[0].Identities) != 1 {
		return nil, fmt.Errorf("VSIX manifest must contain exactly one package identity")
	}
	metadata := packagedVSIX.Metadata[0]
	identity := metadata.Identities[0]
	if identity.Target != target.ID {
		return nil, fmt.Errorf("VSIX target platform %q does not match requested target %s", identity.Target, target.ID)
	}
	if identity.Name != manifest.Name || identity.Version != manifest.Version || identity.Publisher != manifest.Publisher {
		return nil, fmt.Errorf("VSIX manifest identity does not match source manifest")
	}
	if stable {
		for _, property := range metadata.Properties {
			if property.ID == "Microsoft.VisualStudio.Code.PreRelease" {
				return nil, fmt.Errorf("VSIX is marked as a Marketplace prerelease")
			}
		}
	}

	packageBytes, err := readZipEntry(entries["extension/package.json"])
	if err != nil {
		return nil, err
	}
	var packagedManifest vscodeManifest
	if err := json.Unmarshal(packageBytes, &packagedManifest); err != nil {
		return nil, err
	}
	if packagedManifest != manifest {
		return nil, fmt.Errorf("packaged manifest identity does not match source manifest")
	}

	binary := entries[binaryEntry]
	if releaseTarget.Unix && binary.Mode().Perm() != 0o755 {
		return nil, fmt.Errorf("packaged %s mode is not 0755", releaseTarget.BinaryName)
	}
	return binary, nil
}

func readZipEntry(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	var buffer bytes.Buffer
	if err := copyLimited(&buffer, reader, maximumVSIXEntrySize, file.Name); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
