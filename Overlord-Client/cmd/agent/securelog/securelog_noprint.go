//go:build noprint
// +build noprint

package securelog

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxEntries       = 2048
	maxLineBytes     = 64 * 1024
	maxSnapshotCount = 512
)

type encryptedEnvelope struct {
	V          int    `json:"v"`
	Alg        string `json:"alg"`
	Seq        uint64 `json:"seq"`
	At         int64  `json:"at"`
	Source     string `json:"source"`
	WrappedKey string `json:"wrappedKey"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type captureWriter struct {
	source string
}

var (
	mu          sync.Mutex
	entries     []Entry
	dropped     uint64
	seq         uint64
	enabled     atomic.Bool
	lastError   atomic.Value
	publicKey   *rsa.PublicKey
	originalOut *os.File
	originalErr *os.File
)

func Install(publicKeyB64 string) {
	if enabled.Load() {
		return
	}
	originalOut = os.Stdout
	originalErr = os.Stderr

	key, err := parsePublicKey(publicKeyB64)
	if err != nil {
		setError(err.Error())
		log.SetOutput(io.Discard)
		redirectToNull()
		return
	}
	publicKey = key
	enabled.Store(true)

	log.SetOutput(captureWriter{source: "log"})
	log.SetFlags(log.LstdFlags)
	redirectPipe("stdout", originalOut, func(f *os.File) { os.Stdout = f })
	redirectPipe("stderr", originalErr, func(f *os.File) { os.Stderr = f })
}

func SnapshotLogs(sinceSeq uint64, limit int) Snapshot {
	mu.Lock()
	defer mu.Unlock()

	if limit <= 0 || limit > maxSnapshotCount {
		limit = maxSnapshotCount
	}
	out := make([]Entry, 0, min(limit, len(entries)))
	for _, entry := range entries {
		if entry.Seq <= sinceSeq {
			continue
		}
		out = append(out, entry)
		if len(out) >= limit {
			break
		}
	}
	var from, to uint64
	if len(out) > 0 {
		from = out[0].Seq
		to = out[len(out)-1].Seq
	}
	return Snapshot{
		Entries: out,
		Dropped: dropped,
		FromSeq: from,
		ToSeq:   to,
		Enabled: enabled.Load(),
		Error:   currentError(),
	}
}

func (w captureWriter) Write(p []byte) (int, error) {
	record(w.source, p)
	return len(p), nil
}

func redirectPipe(source string, mirror *os.File, assign func(*os.File)) {
	reader, writer, err := os.Pipe()
	if err != nil {
		setError(fmt.Sprintf("%s pipe failed: %v", source, err))
		redirectToNull()
		return
	}
	assign(writer)
	go readPipe(source, reader, mirror)
}

func readPipe(source string, reader *os.File, mirror *os.File) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxLineBytes)
	for scanner.Scan() {
		record(source, append(scanner.Bytes(), '\n'))
	}
	if err := scanner.Err(); err != nil {
		record("securelog", []byte(fmt.Sprintf("%s capture error: %v\n", source, err)))
	}
}

func record(source string, raw []byte) {
	if !enabled.Load() || publicKey == nil || len(raw) == 0 {
		return
	}
	if len(raw) > maxLineBytes {
		raw = append(raw[:maxLineBytes], []byte("\n[securelog] line truncated\n")...)
	}
	raw = bytes.TrimRight(raw, "\r\n")
	if len(raw) == 0 {
		return
	}

	nextSeq := atomic.AddUint64(&seq, 1)
	now := time.Now().UnixMilli()
	blob, err := encryptEntry(nextSeq, now, source, raw)
	if err != nil {
		setError(err.Error())
		return
	}

	entry := Entry{Seq: nextSeq, At: now, Source: source, Blob: blob}
	mu.Lock()
	if len(entries) >= maxEntries {
		copy(entries, entries[1:])
		entries[len(entries)-1] = entry
		dropped++
	} else {
		entries = append(entries, entry)
	}
	mu.Unlock()

	mirrorEncrypted(entry)
}

func encryptEntry(seq uint64, at int64, source string, plaintext []byte) (string, error) {
	aesKey := make([]byte, 32)
	nonce := make([]byte, 12)
	if _, err := rand.Read(aesKey); err != nil {
		return "", err
	}
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	aad := []byte(fmt.Sprintf("%d:%d:%s", seq, at, source))
	ciphertext := gcm.Seal(nil, nonce, plaintext, aad)
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, publicKey, aesKey, aad)
	if err != nil {
		return "", err
	}
	env := encryptedEnvelope{
		V:          1,
		Alg:        "RSA-OAEP-SHA256+A256GCM",
		Seq:        seq,
		At:         at,
		Source:     source,
		WrappedKey: base64.StdEncoding.EncodeToString(wrapped),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}
	jsonBytes, err := json.Marshal(env)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(jsonBytes), nil
}

func mirrorEncrypted(entry Entry) {
	if originalOut == nil {
		return
	}
	_, _ = fmt.Fprintf(originalOut, "OVERLORD-SECURE-LOG v1 seq=%d source=%s %s\n", entry.Seq, entry.Source, entry.Blob)
}

func parsePublicKey(publicKeyB64 string) (*rsa.PublicKey, error) {
	raw := strings.TrimSpace(publicKeyB64)
	if raw == "" {
		return nil, fmt.Errorf("secure log public key missing")
	}
	der, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("secure log public key decode failed: %w", err)
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("secure log public key parse failed: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("secure log public key is not RSA")
	}
	return rsaPub, nil
}

func redirectToNull() {
	file, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return
	}
	os.Stdout = file
	os.Stderr = file
}

func setError(msg string) {
	lastError.Store(msg)
}

func currentError() string {
	if v := lastError.Load(); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
