package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	const version = "0.1.0"
	const commit = "98a63bb3ae9740becb71f9e217f422df32b58296"
	const xml = `<idea-plugin><id>org.ferretlang.jetbrains</id><name>Ferret</name><vendor>Ferret</vendor><version>0.1.0</version><idea-version since-build="262"/></idea-plugin>`
	jar := jetbrainsArchiveRoot + "/lib/ferret-jetbrains-0.1.0.jar"
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
		{"fixture in JAR", func(j, z map[string][]byte) { j["test-fixtures/wire-host"] = nil }},
		{"extra ZIP entry", func(j, z map[string][]byte) { z["ferret-jetbrains/runtime.json"] = nil }},
		{"second descriptor", func(j, z map[string][]byte) { z["ferret-jetbrains/lib/stale.jar"] = testZip(t, j) }},
		{"missing descriptor", func(j, z map[string][]byte) { delete(j, "META-INF/plugin.xml") }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			nested := map[string][]byte{"META-INF/plugin.xml": []byte(xml), "META-INF/MANIFEST.MF": []byte("Manifest-Version: 1.0\r\nFerret-Release-Commit: " + commit + "\r\n\r\n")}
			outer := map[string][]byte{}
			if tc.edit != nil {
				tc.edit(nested, outer)
			}
			outer[jar] = testZip(t, nested)
			archive := filepath.Join(dir, "plugin.zip")
			writeTestFile(t, archive, testZip(t, outer), 0o644)
			err := checkPluginDescriptor(archive, dir, version, "262", commit)
			if (tc.edit == nil) != (err == nil) {
				t.Fatalf("descriptor: %v", err)
			}
		})
	}
	path := filepath.Join(dir, "oversize.zip")
	writeTestFile(t, path, []byte{1}, 0o644)
	if err := os.Truncate(path, marketplaceMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if err := checkMarketplaceSize(path); err == nil || !strings.Contains(err.Error(), "400000001") {
		t.Fatalf("size failure: %v", err)
	}
}
