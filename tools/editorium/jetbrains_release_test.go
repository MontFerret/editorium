package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestJetBrainsReleaseMetadata(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		version       string
		pre, eligible bool
	}{
		{"0.1.0", false, true}, {"1.0.0-beta.2", true, false}, {"1.0.0+build.7", false, false},
	} {
		writeTestFile(t, filepath.Join(root, jetbrainsVersionSource), []byte("pluginVersion="+tc.version+"\n"), 0o644)
		m, err := resolveReleaseMetadata("jetbrains", tc.version, root)
		name := "ferret-jetbrains-" + tc.version + "-signed.zip"
		if err != nil || m.Tag != "jetbrains/v"+tc.version || m.Title != "Ferret JetBrains "+tc.version || m.Prerelease != tc.pre || m.MarketplaceEligible != tc.eligible || !slices.Equal(m.Assets, []string{name, name + ".sha256"}) {
			t.Fatalf("metadata %s: %+v %v", tc.version, m, err)
		}
	}
	for _, version := range []string{"1", "1.2", "v1.2.3", "1.2.03", "1.2.3-alpha.01", "0.2.0"} {
		if _, err := resolveReleaseMetadata("jetbrains", version, root); err == nil {
			t.Fatalf("accepted %s", version)
		}
	}
	writeTestFile(t, filepath.Join(root, jetbrainsVersionSource), []byte("pluginVersion=0.1.0\npluginVersion=1.2.3\n"), 0o644)
	if _, err := jetbrainsPluginVersion(root); err == nil {
		t.Fatal("accepted ambiguous version source")
	}
}

func TestJetBrainsReleaseTagAtValidatedCommit(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	ctx := context.Background()
	tag := "jetbrains/v0.1.0"
	head := fixture.git(t, "rev-parse", "HEAD")
	fixture.git(t, "config", "push.followTags", "true")
	fixture.git(t, "tag", "-a", "unrelated/v1.0.0", "-m", "unrelated")
	if err := runReleaseWithValidator(ctx, fixture.work, "jetbrains", "0.1.0", func(context.Context, string, string) error { return errors.New("strict validation failed") }); err == nil {
		t.Fatal("validation failure accepted")
	}
	assertMissingGitRef(t, fixture.work, "refs/tags/"+tag)
	assertMissingBareGitRef(t, fixture.remote, "refs/tags/"+tag)
	if err := runReleaseWithValidator(ctx, fixture.work, "jetbrains", "0.1.0", func(context.Context, string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if bareGit(t, fixture.remote, "cat-file", "-t", "refs/tags/"+tag) != "tag" || bareGit(t, fixture.remote, "rev-parse", "refs/tags/"+tag+"^{}") != head {
		t.Fatal("invalid remote annotated tag")
	}
	assertMissingBareGitRef(t, fixture.remote, "refs/tags/unrelated/v1.0.0")
	m, err := metadataFromTag(fixture.work, tag)
	if err != nil || m.Commit != head {
		t.Fatalf("tag metadata: %v %v", m, err)
	}
	fixture.git(t, "tag", "jetbrains/v1.0.0")
	for _, bad := range []string{"jetbrains/0.1.0", "jetbrains/v0.1", "jetbrains/v1.0.0"} {
		if _, err := metadataFromTag(fixture.work, bad); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	fixture.git(t, "commit", "--allow-empty", "-m", "another commit")
	if _, err := metadataFromTag(fixture.work, tag); err == nil {
		t.Fatal("accepted tag on another commit")
	}
}

func TestJetBrainsReleaseHiddenVersionChangeDuringValidation(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	err := runReleaseWithValidator(context.Background(), fixture.work, "jetbrains", "0.1.0", func(context.Context, string, string) error {
		fixture.git(t, "update-index", "--assume-unchanged", jetbrainsVersionSource)
		writeTestFile(t, filepath.Join(fixture.work, jetbrainsVersionSource), []byte("pluginVersion=0.2.0\n"), 0o644)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "differs from the tracked HEAD") {
		t.Fatalf("hidden edit: %v", err)
	}
	assertMissingGitRef(t, fixture.work, "refs/tags/jetbrains/v0.1.0")
}

func TestJetBrainsReleaseQualification(t *testing.T) {
	root := editoriumTestRepositoryRoot(t)
	// Verify the release caller and reusable workflow agree on the same input,
	// and the configured task explicitly sets it in the forked test JVM.
	for file, checks := range map[string][]string{
		".github/workflows/release-jetbrains.yml":    {"uses: ./.github/workflows/jetbrains-validation.yml", "strict-qualification: true", "needs: [metadata, qualify]"},
		".github/workflows/jetbrains-validation.yml": {"workflow_call:", "FERRET_TEST_PASSIVE_HOST_LOSS: ${{ inputs.strict-qualification && '1' || '0' }}", "run: make test jetbrains", "fail-fast: false"},
		"extensions/jetbrains/build.gradle.kts":      {`environment("FERRET_TEST_PASSIVE_HOST_LOSS", passiveHostLoss.get())`},
	} {
		data, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			t.Fatal(err)
		}
		for _, part := range checks {
			if !strings.Contains(string(data), part) {
				t.Fatalf("%s missing %q", file, part)
			}
		}
	}
}

func TestJetBrainsDescriptorAndDistribution(t *testing.T) {
	dir := t.TempDir()
	resources := filepath.Join(dir, "resources")
	const icon = "icons/ferret.png"
	writeTestFile(t, filepath.Join(resources, icon), []byte("icon"), 0o644)
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "other.png"), []byte("other icon"), 0o644)
	linkErr := os.Symlink(outside, filepath.Join(resources, "linked"))
	const version = "0.1.0"
	const commit = "98a63bb3ae9740becb71f9e217f422df32b58296"
	const xml = `<idea-plugin><id>org.ferretlang.jetbrains</id><name>Ferret</name><vendor>Ferret</vendor><version>0.1.0</version><idea-version since-build="262"/></idea-plugin>`
	jar := jetbrainsArchiveRoot + "/lib/ferret-jetbrains-0.1.0.jar"
	const dependency = "org.eclipse.lsp4j.debug-0.24.0.jar"
	const lib = "ferret-jetbrains/lib/"
	payload := testZip(t, map[string][]byte{"debug.class": {42}})
	libs := map[string]string{filepath.Base(jar): "", dependency: fmt.Sprintf("%x", sha256.Sum256(payload)), "options.jar": ""}
	tests := []struct {
		name string
		edit func(map[string][]byte, map[string][]byte)
	}{
		{"valid", nil},
		{"version", func(j, z map[string][]byte) {
			j["META-INF/plugin.xml"] = []byte(strings.Replace(xml, version, "0.2.0", 1))
		}},
		{"identity", func(j, z map[string][]byte) {
			j["META-INF/plugin.xml"] = []byte(strings.Replace(xml, jetbrainsPluginID, "other", 1))
		}},
		{"compatibility", func(j, z map[string][]byte) {
			j["META-INF/plugin.xml"] = []byte(strings.Replace(xml, "since-build", `until-build="263" since-build`, 1))
		}},
		{"commit", func(j, z map[string][]byte) { j["META-INF/MANIFEST.MF"] = []byte("Ferret-Release-Commit: other\n") }},
		{"temporary config", func(j, z map[string][]byte) { j["local-override.json"] = []byte("{}") }},
		{"undeclared resource", func(j, z map[string][]byte) { j["icons/other.png"] = nil }},
		{"symlinked resource directory", func(j, z map[string][]byte) { j["linked/other.png"] = nil }},
		{"fixture in JAR", func(j, z map[string][]byte) { j["test-fixtures/wire-host"] = nil }},
		{"extra ZIP entry", func(j, z map[string][]byte) { z["ferret-jetbrains/runtime.json"] = nil }},
		{"second descriptor", func(j, z map[string][]byte) { z[lib+"options.jar"] = testZip(t, j) }},
		{"missing runtime library", func(j, z map[string][]byte) { delete(z, lib+dependency) }},
		{"unexpected runtime library", func(j, z map[string][]byte) { z[lib+"stale.jar"] = payload }},
		{"changed runtime library", func(j, z map[string][]byte) { z[lib+dependency] = testZip(t, map[string][]byte{"debug.class": {0}}) }},

		{"missing descriptor", func(j, z map[string][]byte) { delete(j, "META-INF/plugin.xml") }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "symlinked resource directory" && linkErr != nil {
				if runtime.GOOS == "windows" {
					t.Skipf("cannot create directory symlink: %v", linkErr)
				}
				t.Fatal(linkErr)
			}
			nested := map[string][]byte{
				"META-INF/plugin.xml":  []byte(xml),
				"META-INF/MANIFEST.MF": []byte("Manifest-Version: 1.0\r\nFerret-Release-Commit: " + commit + "\r\n\r\n"),
				icon:                   []byte("icon"),
			}
			outer := map[string][]byte{lib + dependency: payload, lib + "options.jar": testZip(t, nil)}
			if tc.edit != nil {
				tc.edit(nested, outer)
			}
			outer[jar] = testZip(t, nested)
			archive := filepath.Join(dir, "plugin.zip")
			data := testZip(t, outer)
			writeTestFile(t, archive, data, 0o644)
			err := checkPluginDescriptor(archive, resources, version, "262", commit, libs)
			if (tc.edit == nil) != (err == nil) {
				t.Fatalf("descriptor: %v", err)
			}
			want := map[string]string{
				"missing runtime library":      "missing plugin library " + dependency,
				"unexpected runtime library":   "unexpected plugin library " + lib + "stale.jar",
				"changed runtime library":      "checksum mismatch: " + lib + dependency,
				"undeclared resource":          "unexpected file in plugin JAR: icons/other.png",
				"symlinked resource directory": "unexpected file in plugin JAR: linked/other.png",
			}
			if message := want[tc.name]; message != "" && !strings.Contains(err.Error(), message) {
				t.Fatalf("got %v, want %s", err, message)
			}
		})
	}
	t.Run("duplicate runtime library", func(t *testing.T) {
		var out bytes.Buffer
		w := zip.NewWriter(&out)
		for range 2 {
			f, err := w.Create(lib + dependency)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.Write(payload); err != nil {
				t.Fatal(err)
			}
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		archive := filepath.Join(dir, "duplicate.zip")
		writeTestFile(t, archive, out.Bytes(), 0o644)
		if err := checkPluginDescriptor(archive, resources, version, "262", commit, libs); err == nil || !strings.Contains(err.Error(), "duplicate plugin library "+lib+dependency) {
			t.Fatalf("duplicate archive: %v", err)
		}
	})
	path := filepath.Join(dir, "oversize.zip")
	writeTestFile(t, path, []byte{1}, 0o644)
	if err := os.Truncate(path, marketplaceMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if err := checkMarketplaceSize(path); err == nil || !strings.Contains(err.Error(), "400000001") {
		t.Fatalf("size failure: %v", err)
	}
}

func TestJetBrainsRemoteAnnotation(t *testing.T) {
	f := newReleaseGitFixture(t)
	const tag = "jetbrains/v0.1.0"
	ref := "refs/tags/" + tag
	head := f.git(t, "rev-parse", "HEAD")
	f.git(t, "tag", "-a", tag, "-m", "qualified")
	f.git(t, "push", "origin", ref)
	m, err := metadataFromTag(f.work, tag)
	if err != nil {
		t.Fatal(err)
	}
	if m.Commit != head || m.TagObject != f.git(t, "rev-parse", ref) {
		t.Fatal("incorrect qualified IDs")
	}
	t.Setenv("JETBRAINS_QUALIFIED_TAG_OBJECT", m.TagObject)
	t.Setenv("JETBRAINS_RELEASE_COMMIT", m.Commit)
	if err := requireRemoteTag(context.Background(), f.work, m); err != nil {
		t.Fatal(err)
	}
	// Only change the bare remote. Checkout and local tag still describe the qualified commit.
	f.git(t, "commit", "--allow-empty", "-m", "newer")
	newer := f.git(t, "rev-parse", "HEAD")
	f.git(t, "tag", "-a", "moved", "-m", "another commit", newer)
	f.git(t, "tag", "-a", "replaced", "-m", "same commit", head)
	f.git(t, "push", "origin", "refs/tags/moved", "refs/tags/replaced")
	f.git(t, "checkout", "--detach", head)
	for _, tc := range []struct{ name, id string }{
		{"lightweight", head}, {"moved", f.git(t, "rev-parse", "refs/tags/moved")}, {"replaced", f.git(t, "rev-parse", "refs/tags/replaced")}, {"deleted", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.id == "" {
				bareGit(t, f.remote, "update-ref", "-d", ref)
			} else {
				bareGit(t, f.remote, "update-ref", ref, tc.id)
			}
			if err := requireRemoteTag(context.Background(), f.work, m); err == nil {
				t.Fatal("accepted changed tag")
			}
			for _, op := range []string{"sign", "publish", "marketplace-upload", "verify-signed"} {
				err := runReleaseCI(f.work, []string{op, "--tag", tag})
				if err == nil || !strings.Contains(err.Error(), "tag") {
					t.Fatalf("%s reached operation: %v", op, err)
				}
			}
		})
	}
	f.git(t, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "unavailable"))
	if err := requireRemoteTag(context.Background(), f.work, m); err == nil || !strings.Contains(err.Error(), "ls-remote") {
		t.Fatalf("transport failure: %v", err)
	}
}
