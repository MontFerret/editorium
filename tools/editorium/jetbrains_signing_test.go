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
	ca, caKey := testSigningCertificate(t, "Issuer", nil, nil)
	leaf, keyData := testSigningCertificate(t, "Ferret", ca, caKey)
	key := filepath.Join(t.TempDir(), "key.pem")
	writeTestSigningKey(t, key, keyData)
	cert := testCertificateChain(t, leaf, ca)
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
	t.Run("self-signed author", func(t *testing.T) {
		dir := t.TempDir()
		input := filepath.Join(dir, "small.zip")
		output := filepath.Join(dir, "signed.zip")
		writeTestFile(t, input, testZip(t, map[string][]byte{"plugin.txt": []byte("test")}), 0o644)
		keyPath := filepath.Join(dir, "key.pem")
		writeTestSigningKey(t, keyPath, caKey)
		t.Setenv("JETBRAINS_CERTIFICATE_FILE", testCertificateChain(t, ca))
		t.Setenv("JETBRAINS_SIGNING_KEY_FILE", keyPath)
		if err := runJetBrainsSigner(context.Background(), root, "signPlugin", input, output); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(keyPath); err != nil {
			t.Fatal(err)
		}
		t.Setenv("JETBRAINS_SIGNING_KEY_FILE", "")
		if err := runJetBrainsSigner(context.Background(), root, "verifyPluginSignature", "", output); err != nil {
			t.Fatal(err)
		}
	})
	sibling, _ := testSigningCertificate(t, "Sibling", ca, caKey)
	other, _ := testSigningCertificate(t, "Other issuer", nil, nil)
	badPEM := filepath.Join(t.TempDir(), "bad.pem")
	writeTestFile(t, badPEM, []byte("malformed"), 0o644)
	for name, chain := range map[string]string{"sibling": testCertificateChain(t, sibling, ca), "wrong CA": testCertificateChain(t, other), "reversed": testCertificateChain(t, ca, leaf), "malformed": badPEM} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("JETBRAINS_CERTIFICATE_FILE", chain)
			if err := verify(); err == nil {
				t.Fatal("accepted invalid author chain")
			}
		})
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

func testSigningCertificate(t *testing.T, name string, parent *x509.Certificate, parentKey *rsa.PrivateKey) (*x509.Certificate, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	if parent == nil {
		template.IsCA = true
		template.BasicConstraintsValid = true
		template.KeyUsage |= x509.KeyUsageCertSign
		parent = &template
		parentKey = key
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key
}

func writeTestSigningKey(t *testing.T, path string, key *rsa.PrivateKey) {
	t.Helper()
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o600)
}

func testCertificateChain(t *testing.T, certs ...*x509.Certificate) string {
	t.Helper()
	var chain []byte
	for _, cert := range certs {
		chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})...)
	}
	path := filepath.Join(t.TempDir(), "chain.pem")
	writeTestFile(t, path, chain, 0o644)
	return path
}
