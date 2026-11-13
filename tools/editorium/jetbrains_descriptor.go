package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"maps"

	"encoding/xml"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

type jetbrainsDescriptor struct {
	XMLName       xml.Name `xml:"idea-plugin"`
	IDs           []string `xml:"id"`
	Names         []string `xml:"name"`
	Vendors       []string `xml:"vendor"`
	Versions      []string `xml:"version"`
	Compatibility []struct {
		Since string  `xml:"since-build,attr"`
		Until *string `xml:"until-build,attr"`
	} `xml:"idea-version"`
}

func checkPluginDescriptor(archivePath, resources, version, since, commit string, libraries map[string]string) error {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	mainJar := jetbrainsArchiveRoot + "/lib/" + jetbrainsArchiveRoot + "-" + version + ".jar"
	seen := make(map[string]bool, len(libraries))
	for _, entry := range archive.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if err := checkPluginEntry(entry); err != nil {
			return err
		}
		if strings.HasPrefix(name, jetbrainsArchiveRoot+"/ferretd/") {
			continue
		}
		if entry.FileInfo().IsDir() && (name == jetbrainsArchiveRoot || name == jetbrainsArchiveRoot+"/lib" || name == jetbrainsArchiveRoot+"/ferretd") {
			continue
		}

		if path.Dir(name) != jetbrainsArchiveRoot+"/lib" || path.Ext(name) != ".jar" {
			return fmt.Errorf("unexpected plugin ZIP entry %q", entry.Name)
		}
		base := path.Base(name)
		digest, ok := libraries[base]
		if !ok {
			return fmt.Errorf("unexpected plugin library %s", name)
		}
		if seen[base] {
			return fmt.Errorf("duplicate plugin library %s", name)
		}
		seen[base] = true
		contents, err := readJetBrainsZipEntry(entry)
		if err != nil {
			return err
		}
		if digest != "" && fmt.Sprintf("%x", sha256.Sum256(contents)) != digest {
			return fmt.Errorf("plugin library checksum mismatch: %s", name)
		}
		jar, err := zip.NewReader(bytes.NewReader(contents), int64(len(contents)))
		if err != nil {
			return fmt.Errorf("open %s: %w", name, err)
		}
		if err := checkPluginJar(jar, name == mainJar, resources, version, since, commit); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	if !seen[path.Base(mainJar)] {
		return fmt.Errorf("missing plugin JAR %s", mainJar)
	}
	for _, name := range slices.Sorted(maps.Keys(libraries)) {
		if !seen[name] {
			return fmt.Errorf("missing plugin library %s", name)
		}
	}
	return nil
}

func checkPluginEntry(entry *zip.File) error {
	name := strings.TrimSuffix(entry.Name, "/")
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\:") || (!entry.FileInfo().IsDir() && !entry.Mode().IsRegular()) {
		return fmt.Errorf("unsafe plugin entry %q", entry.Name)
	}
	for part := range strings.SplitSeq(strings.ToLower(name), "/") {
		switch part {
		case "fixtures", "test-fixtures", "wire-host", "wire-host.exe", "runtime.json", "runtimes.json", ".gradle", ".intellijplatform", ".cache", "build", "test-results", "node_modules", ".git":
			return fmt.Errorf("development file in plugin: %s", name)
		}
	}
	return nil
}

func checkPluginJar(jar *zip.Reader, primary bool, resources, version, since, commit string) error {
	var descriptor, manifest *zip.File
	seen := make(map[string]bool, len(jar.File))
	for _, entry := range jar.File {
		if err := checkPluginEntry(entry); err != nil {
			return err
		}
		if seen[entry.Name] {
			return fmt.Errorf("duplicate JAR entry %s", entry.Name)
		}
		seen[entry.Name] = true
		switch entry.Name {
		case "META-INF/plugin.xml":
			if !primary || descriptor != nil {
				return fmt.Errorf("ambiguous plugin descriptor")
			}
			descriptor = entry
		case "META-INF/MANIFEST.MF":
			if manifest != nil {
				return fmt.Errorf("duplicate JAR manifest")
			}
			manifest = entry
		default:
			if primary && !entry.FileInfo().IsDir() && !productionPluginEntry(entry.Name, resources) {
				return fmt.Errorf("unexpected file in plugin JAR: %s", entry.Name)
			}
		}
	}
	if !primary {
		return nil
	}
	data, err := readJetBrainsZipEntry(descriptor)
	if err != nil {
		return fmt.Errorf("plugin.xml: %w", err)
	}
	var d jetbrainsDescriptor
	if err := xml.Unmarshal(data, &d); err != nil {
		return err
	}
	if !slices.Equal(d.IDs, []string{jetbrainsPluginID}) || !slices.Equal(d.Names, []string{"Ferret"}) || !slices.Equal(d.Vendors, []string{"Ferret"}) || !slices.Equal(d.Versions, []string{version}) {
		return fmt.Errorf("unexpected plugin identity or version: ID=%q name=%q vendor=%q version=%q, expected %s %s", d.IDs, d.Names, d.Vendors, d.Versions, jetbrainsPluginID, version)
	}
	if len(d.Compatibility) != 1 || d.Compatibility[0].Since != since || d.Compatibility[0].Until != nil {
		return fmt.Errorf("unexpected plugin compatibility; expected since-build %q and an open upper bound", since)
	}
	if commit != "" {
		data, err := readJetBrainsZipEntry(manifest)
		if err != nil {
			return err
		}
		main, _, _ := strings.Cut(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n\n")
		var commits []string
		for line := range strings.SplitSeq(strings.ReplaceAll(main, "\n ", ""), "\n") {
			key, value, ok := strings.Cut(line, ": ")
			if ok && strings.EqualFold(key, "Ferret-Release-Commit") {
				commits = append(commits, value)
			}
		}
		if !slices.Equal(commits, []string{commit}) {
			return fmt.Errorf("plugin commit %q does not match tagged commit %s", commits, commit)
		}
	}
	return nil
}

// Compiled classes, Kotlin module metadata and declared main resources belong in the plugin JAR.
func productionPluginEntry(name, resources string) bool {
	if strings.HasSuffix(name, ".class") {
		return strings.HasPrefix(name, "org/ferretlang/jetbrains/") && !strings.HasPrefix(name, "org/ferretlang/jetbrains/integration/")
	}
	if path.Dir(name) == "META-INF" && strings.HasSuffix(name, ".kotlin_module") {
		return true
	}
	return regularFile(filepath.Join(resources, filepath.FromSlash(name)))
}
