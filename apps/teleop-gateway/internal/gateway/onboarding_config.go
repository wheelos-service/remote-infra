package gateway

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
)

type onboardingConfig struct {
	SupportedVersion       string `json:"supported_version"`
	CasdoorURL             string `json:"casdoor_url"`
	JWKSURL                string `json:"jwks_url"`
	ManagementClientID     string `json:"management_client_id"`
	ManagementClientSecret string `json:"management_client_secret"`
	CasdoorOrganization    string `json:"casdoor_organization"`
	BrowserApplication     string `json:"browser_application"`
	Certificate            string `json:"certificate"`
	GatewayURL             string `json:"gateway_url"`
	EncryptionKeyFile      string `json:"encryption_key_file"`
}

var errOnboardingConfig = errors.New("invalid protected onboarding configuration")

func readOnboardingProtectedFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > limit {
		return nil, errOnboardingConfig
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errOnboardingConfig
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errOnboardingConfig
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errOnboardingConfig
	}
	return data, nil
}

func onboardingLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func onboardingSafeURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && onboardingLoopback(u.Hostname()))
}

func loadOnboardingConfig(path string) (onboardingConfig, cipher.AEAD, error) {
	var config onboardingConfig
	data, err := readOnboardingProtectedFile(path, 64<<10)
	if err != nil {
		return config, nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil || decoder.Decode(new(any)) != io.EOF {
		return config, nil, errOnboardingConfig
	}
	for _, raw := range []string{config.CasdoorURL, config.JWKSURL, config.GatewayURL} {
		if !onboardingSafeURL(raw) || len(raw) > 2048 {
			return config, nil, errOnboardingConfig
		}
		if config.SupportedVersion != "4.25.0" {
			return config, nil, errOnboardingConfig
		}
	}
	// Management credentials may only be sent to a single origin. Casdoor
	// resource names are path components, not arbitrary supplied URLs.
	for _, field := range []string{config.CasdoorOrganization, config.BrowserApplication, config.Certificate} {
		if field == "" || len(field) > 128 || strings.ContainsAny(field, "/\\?\r\n\t ") {
			return config, nil, errOnboardingConfig
		}
	}
	if config.ManagementClientID == "" || len(config.ManagementClientID) > 256 || config.ManagementClientSecret == "" || len(config.ManagementClientSecret) > 4096 {
		return config, nil, errOnboardingConfig
	}
	keyData, err := readOnboardingProtectedFile(config.EncryptionKeyFile, 128)
	if err != nil {
		return config, nil, err
	}
	key, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(keyData)))
	if err != nil || len(key) != 32 {
		return config, nil, errOnboardingConfig
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return config, nil, errOnboardingConfig
	}
	aead, err := cipher.NewGCM(block)
	return config, aead, err
}

func onboardingRandom() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", errors.New("secure random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (s *OnboardingService) encryptCredential(secret string) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, errors.New("secure random source unavailable")
	}
	return s.aead.Seal(nonce, nonce, []byte(secret), []byte("teleop-onboarding-credential-v1")), nil
}

func (s *OnboardingService) decryptCredential(ciphertext []byte) (string, error) {
	size := s.aead.NonceSize()
	if len(ciphertext) < size+s.aead.Overhead() || len(ciphertext) > 4096 {
		return "", errors.New("credential unavailable")
	}
	clear, err := s.aead.Open(nil, ciphertext[:size], ciphertext[size:], []byte("teleop-onboarding-credential-v1"))
	if err != nil || len(clear) != 43 {
		return "", errors.New("credential unavailable")
	}
	return string(clear), nil
}
