// auth-admin is an offline, explicit platform bootstrap, not a public endpoint.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func main() {
	input := flag.String("input", "", "owner-only JSON bootstrap file (required)")
	dsnFile := flag.String("database-url-file", "", "owner-only database URL file; otherwise AUTHORIZATION_DATABASE_URL")
	flag.Parse()
	if err := run(*input, *dsnFile); err != nil {
		fmt.Fprintln(os.Stderr, "auth-admin:", err)
		os.Exit(1)
	}
	fmt.Println("Manual-provisioning platform bootstrap complete (or already present). No identity-provider credentials were created.")
}

func run(inputPath, dsnPath string) error {
	if inputPath == "" || flag.NArg() != 0 {
		return errors.New("use --input protected.json [--database-url-file protected-dsn]")
	}
	input, err := protectedRead(inputPath)
	if err != nil {
		return err
	}
	var in authorization.BootstrapInput
	if err := decodeInput(input, &in); err != nil {
		return fmt.Errorf("invalid bootstrap JSON: %w", err)
	}
	dsn := os.Getenv("AUTHORIZATION_DATABASE_URL")
	if dsnPath != "" {
		data, err := protectedRead(dsnPath)
		if err != nil {
			return err
		}
		dsn = strings.TrimSpace(string(data))
	}
	if dsn == "" {
		return errors.New("database URL file or AUTHORIZATION_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return errors.New("invalid database configuration")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return errors.New("connect to bootstrap database failed")
	}
	store, err := authorization.NewStore(db)
	if err != nil {
		return err
	}
	if err := store.Migrate(ctx); err != nil {
		return errors.New("authorization migration failed")
	}
	if err := store.Bootstrap(ctx, in); err != nil {
		if errors.Is(err, authorization.ErrConflict) || errors.Is(err, authorization.ErrInvalidRegistration) ||
			errors.Is(err, authorization.ErrBootstrapGatewayRunning) {
			return err
		}
		return errors.New("bootstrap transaction failed; no partial change committed")
	}
	return nil
}

func protectedRead(path string) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("cannot open protected input file")
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, errors.New("cannot inspect protected input file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, errors.New("input files must be regular, owned by the current user, and mode 0600 or stricter")
	}
	data, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 64<<10 {
		return nil, errors.New("protected input file exceeds 64 KiB")
	}
	return data, nil
}

func decodeInput(data []byte, in *authorization.BootstrapInput) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token != json.Delim('{') {
		return errors.New("expected object")
	}
	allowed := map[string]bool{"org_id": true, "org_name": true, "user_id": true, "name": true, "issuer": true, "subject": true}
	values := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		field, ok := token.(string)
		if !ok || !allowed[field] {
			return errors.New("unknown field")
		}
		if _, exists := values[field]; exists {
			return errors.New("duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		values[field] = value
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return json.Unmarshal(data, in)
}
