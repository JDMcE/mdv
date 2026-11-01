package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writePair writes a self-signed certificate with the given serial number.
func writePair(t *testing.T, dir string, serial int64, mod time.Time) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "vmname"},
		DNSNames:     []string{"vmname"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	cf, kf := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(cf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
	os.WriteFile(kf, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	os.Chtimes(cf, mod, mod)
	os.Chtimes(kf, mod, mod)
	return cf, kf
}

func serial(t *testing.T, r *Reloader) int64 {
	t.Helper()
	c, err := r.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	x, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return x.SerialNumber.Int64()
}

func TestReload(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	cf, kf := writePair(t, dir, 1, base)
	r, err := New(cf, kf)
	if err != nil {
		t.Fatal(err)
	}
	r.checkEvery = 0
	if s := serial(t, r); s != 1 {
		t.Fatalf("serial %d", s)
	}

	// A renewed pair is picked up.
	writePair(t, dir, 2, base.Add(time.Minute))
	if s := serial(t, r); s != 2 {
		t.Fatalf("after renewal: serial %d", s)
	}

	// A broken pair is ignored and the old certificate kept.
	os.WriteFile(cf, []byte("garbage"), 0o644)
	if s := serial(t, r); s != 2 {
		t.Fatalf("after bad write: serial %d", s)
	}
}

func TestNewErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := New(filepath.Join(dir, "nope.pem"), filepath.Join(dir, "nope.key")); err == nil {
		t.Error("missing files accepted")
	}
	os.WriteFile(filepath.Join(dir, "bad.pem"), []byte("x"), 0o644)
	if _, err := New(filepath.Join(dir, "bad.pem"), filepath.Join(dir, "bad.pem")); err == nil {
		t.Error("invalid files accepted")
	}
}
