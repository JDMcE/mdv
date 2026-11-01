// Package certs serves a TLS certificate from files on disk and picks up
// replacements (e.g. a renewed certificate) without a restart.
package certs

import (
	"crypto/tls"
	"log"
	"os"
	"sync"
	"time"
)

// Reloader holds the current certificate and re-reads the files when their
// modification times change.
type Reloader struct {
	certFile, keyFile string
	checkEvery        time.Duration

	mu       sync.Mutex
	cert     *tls.Certificate
	certMod  time.Time
	keyMod   time.Time
	lastSeen time.Time
}

// New loads the certificate and key, failing if either is missing or invalid.
func New(certFile, keyFile string) (*Reloader, error) {
	r := &Reloader{certFile: certFile, keyFile: keyFile, checkEvery: time.Minute}
	if err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Reloader) load() error {
	cs, err := os.Stat(r.certFile)
	if err != nil {
		return err
	}
	ks, err := os.Stat(r.keyFile)
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return err
	}
	r.cert, r.certMod, r.keyMod = &cert, cs.ModTime(), ks.ModTime()
	return nil
}

func (r *Reloader) changed() bool {
	cs, err1 := os.Stat(r.certFile)
	ks, err2 := os.Stat(r.keyFile)
	return err1 == nil && err2 == nil && (!cs.ModTime().Equal(r.certMod) || !ks.ModTime().Equal(r.keyMod))
}

// GetCertificate is for tls.Config. It checks the files at most once per
// checkEvery; if a new pair fails to load (say, half-written), it keeps
// serving the old one and tries again next time.
func (r *Reloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if time.Since(r.lastSeen) >= r.checkEvery {
		r.lastSeen = time.Now()
		if r.changed() {
			if err := r.load(); err != nil {
				log.Printf("tls: keeping the current certificate: %v", err)
			} else {
				log.Printf("tls: reloaded %s", r.certFile)
			}
		}
	}
	return r.cert, nil
}
