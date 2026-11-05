package main

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestBootstrapJSONRejectsAmbiguousInput(t *testing.T) {
	for _, input := range []string{
		`{"issuer":"first","issuer":"second"}`,
		`{"Issuer":"case-insensitive-bypass"}`,
		`{"subject":"s","unknown":true}`,
		`{"subject":"s"} {}`,
		`[]`,
	} {
		var parsed authorization.BootstrapInput
		if err := decodeInput([]byte(input), &parsed); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
}

func TestPostgresBootstrapCommand(t *testing.T) {
	dsn := os.Getenv("AUTHZ_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set AUTHZ_POSTGRES_TEST_DSN for real PostgreSQL bootstrap command test")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	schema := "bootstrap_cli_" + uuid.NewString()[:8]
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); admin.Close() })
	testDSN := dsn + " search_path=" + schema
	if parsed, err := url.Parse(dsn); err == nil && (parsed.Scheme == "postgres" || parsed.Scheme == "postgresql") {
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		testDSN = parsed.String()
	}
	directory := t.TempDir()
	inputPath := filepath.Join(directory, "bootstrap.json")
	dsnPath := filepath.Join(directory, "database-url")
	if err := os.WriteFile(dsnPath, []byte(testDSN), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inputPath, []byte(`{
				"org_id":"22222222-2222-4222-8222-222222222222","org_name":"Command fleet",
				"user_id":"11111111-1111-4111-8111-111111111111","name":"Command operator",
				"issuer":"https://manual-idp.example.test","subject":"command-platform"
			}`), 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := run(inputPath, dsnPath); err != nil {
			t.Fatalf("bootstrap command: %v", err)
		}
	}
	db, err := sql.Open("pgx", testDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, err := authorization.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if version, err := store.Version(context.Background()); err != nil || version != 1 {
		t.Fatalf("idempotent command version=%d err=%v", version, err)
	}
}

func TestProtectedBootstrapFilePermissionsAndSymlinks(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bootstrap.json")
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedRead(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedRead(path); err == nil {
		t.Fatal("accepted world-readable bootstrap file")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedRead(link); err == nil {
		t.Fatal("accepted symlink bootstrap file")
	}
	if _, err := protectedRead(directory); err == nil {
		t.Fatal("accepted directory bootstrap file")
	}
}
