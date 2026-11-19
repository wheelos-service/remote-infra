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
	"path/filepath"
	"strings"
)

type onboardingConfig struct {
	SupportedVersion       string `json:"supported_version,omitempty"`
	CasdoorVersionExpected string `json:"casdoor_version_expected,omitempty"`
	CasdoorURL             string `json:"casdoor_url,omitempty"`
	JWKSURL                string `json:"jwks_url,omitempty"`
	ManagementClientID     string `json:"management_client_id"`
	ManagementClientSecret string `json:"management_client_secret,omitempty"`
	CasdoorOrganization    string `json:"casdoor_organization"`
	BrowserApplication     string `json:"browser_application"`
	Certificate            string `json:"certificate"`
	GatewayURL             string `json:"gateway_url"`
	ConsoleURL             string `json:"console_url,omitempty"`
	EncryptionKeyFile      string `json:"encryption_key_file,omitempty"`
}

var errOnboardingConfig = errors.New("invalid protected onboarding configuration")

func readOnboardingProtectedFile(path string, limit int64) ([]byte, error) {
	return readOnboardingFile(path, limit, 0600)
}

func readOnboardingCredentialFile(path string, limit int64) ([]byte, error) {
	return readOnboardingFile(path, limit, 0400)
}

func readOnboardingFile(path string, limit int64, permissions os.FileMode) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != permissions || info.Size() > limit {
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
	if config.CasdoorVersionExpected != "" {
		if config.SupportedVersion != "" && config.SupportedVersion != config.CasdoorVersionExpected {
			return config, nil, errOnboardingConfig
		}
		config.SupportedVersion = config.CasdoorVersionExpected
	}
	if config.CasdoorURL == "" {
		config.CasdoorURL = strings.TrimRight(strings.TrimSpace(os.Getenv("OIDC_ISSUER")), "/")
	}
	if config.JWKSURL == "" {
		if envJWKS := strings.TrimSpace(os.Getenv("OIDC_JWKS_URL")); envJWKS != "" {
			config.JWKSURL = envJWKS
		} else if config.CasdoorURL != "" {
			config.JWKSURL = strings.TrimRight(config.CasdoorURL, "/") + "/.well-known/jwks"
		}
	}
	if config.ManagementClientSecret == "" {
		if secret := strings.TrimSpace(os.Getenv("AUTHORIZATION_ONBOARDING_MANAGEMENT_SECRET")); secret != "" {
			config.ManagementClientSecret = secret
		} else if credDir := strings.TrimSpace(os.Getenv("CREDENTIALS_DIRECTORY")); credDir != "" {
			if raw, readErr := readOnboardingCredentialFile(filepath.Join(credDir, "onboarding_management_secret"), 4096); readErr == nil {
				config.ManagementClientSecret = strings.TrimSpace(string(raw))
			}
		}
	}
	if config.ConsoleURL == "" {
		config.ConsoleURL = config.GatewayURL
	}
	for _, raw := range []string{config.CasdoorURL, config.JWKSURL, config.GatewayURL, config.ConsoleURL} {
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
	var keyData []byte
	if config.EncryptionKeyFile != "" {
		keyData, err = readOnboardingProtectedFile(config.EncryptionKeyFile, 128)
		if err != nil {
			return config, nil, err
		}
	} else if envKey := strings.TrimSpace(os.Getenv("AUTHORIZATION_ONBOARDING_ENCRYPTION_KEY")); envKey != "" {
		keyData = []byte(envKey)
	} else if credDir := strings.TrimSpace(os.Getenv("CREDENTIALS_DIRECTORY")); credDir != "" {
		keyData, err = readOnboardingCredentialFile(filepath.Join(credDir, "onboarding_encryption_key"), 128)
		if err != nil {
			return config, nil, err
		}
	} else {
		return config, nil, errOnboardingConfig
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
