package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The packaging job runs this against its actual ZIP. Go-only tests need no JDK or downloads.
func TestJetBrainsReleaseSigning(t *testing.T) {
	if os.Getenv("EDITORIUM_TEST_SIGNING") != "1" {
		t.Skip("requires built JetBrains distribution and Gradle signer")
	}
	root := editoriumTestRepositoryRoot(t)
	v, err := jetbrainsPluginVersion(root)
	if err != nil {
		t.Fatal(err)
	}
	m, err := resolveReleaseMetadata("jetbrains", v, root)
	if err != nil {
		t.Fatal(err)
	}
	m.Commit = os.Getenv("JETBRAINS_RELEASE_COMMIT")
	input := filepath.Join(jetbrainsPackageRoot(root), "build", "distributions", jetbrainsArchiveRoot+"-"+v+".zip")
	digest, err := sha256File(input)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	key, cert := testSigningIdentity(t)
	t.Setenv("JETBRAINS_CERTIFICATE_FILE", cert)
	t.Setenv("JETBRAINS_SIGNING_KEY_FILE", "")
	sign := func() error {
		return jetbrainsReleaseArtifact(context.Background(), root, "sign", dir, input, digest, m)
	}
	verify := func() error {
		return jetbrainsReleaseArtifact(context.Background(), root, "verify-signed", dir, "", "", m)
	}
	if err := sign(); err == nil || !strings.Contains(err.Error(), "JETBRAINS_SIGNING_KEY_FILE") {
		t.Fatalf("missing key: %v", err)
	}
	t.Setenv("JETBRAINS_SIGNING_KEY_FILE", key)
	if err := sign(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JETBRAINS_SIGNING_KEY_FILE", "")
	if err := verify(); err != nil {
		t.Fatal(err)
	}
	_, other := testSigningIdentity(t)
	t.Setenv("JETBRAINS_CERTIFICATE_FILE", other)
	if err := verify(); err == nil {
		t.Fatal("accepted wrong signing certificate")
	}
	t.Setenv("JETBRAINS_CERTIFICATE_FILE", cert)
	output := filepath.Join(dir, m.Assets[0])
	writeTestFile(t, output+".sha256", []byte("stale\n"), 0o644)
	if err := verify(); err == nil || !strings.Contains(err.Error(), "checksum conflicts") {
		t.Fatalf("checksum conflict: %v", err)
	}
	f, err := os.OpenFile(output, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.WriteAt([]byte{0xff}, 100); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := runJetBrainsSigner(context.Background(), root, "verifyPluginSignature", "", output); err == nil {
		t.Fatal("accepted modified signed bytes")
	}
	if err := runJetBrainsSigner(context.Background(), root, "verifyPluginSignature", "", input); err == nil {
		t.Fatal("accepted unsigned ZIP")
	}
}

func testSigningIdentity(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	certificate := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable Editorium test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, &certificate, &certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "key.pem")
	certPath := filepath.Join(dir, "chain.pem")
	writeTestFile(t, keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o600)
	writeTestFile(t, certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	return keyPath, certPath
}
