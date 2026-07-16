package migrations

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

const (
	SchemaV1Version     = 1
	SchemaV1Name        = "schema_v1"
	SchemaV1UserVersion = 1
	// SchemaV1Checksum is intentionally literal. NewRegistry validates the
	// embedded bytes against it, so changing migration history fails closed.
	SchemaV1Checksum    = "a8d932e46a8f09d49b103cf420a408074688f1de1c20c97eee0d1ba8431b786d"
	SchemaV2Version     = 2
	SchemaV2Name        = "operations_outbox_v2"
	SchemaV2UserVersion = 2
	SchemaV2Checksum    = "5fe6f19198f4de50386bcf16727341731e4ec536d2aba8449932aa75f9286a68"
	SchemaV3Version     = 3
	SchemaV3Name        = "operation_start_times_v3"
	SchemaV3UserVersion = 3
	SchemaV3Checksum    = "218a31580d985a36b58abf254ef1695688685bab5ab2dacca112afb136449c32"
	SchemaV4Version     = 4
	SchemaV4Name        = "model_usage_v4"
	SchemaV4UserVersion = 4
	SchemaV4Checksum    = "b764fa51c8945ec4c164c0b5511d92d5999e35147232e62967f7ed08d822f651"
)

var (
	ErrInvalidRegistry = errors.New("migration_registry_invalid")
	//go:embed 0001_schema_v1.sql
	schemaV1SQL string
	//go:embed 0002_operations_outbox_v2.sql
	schemaV2SQL string
	//go:embed 0003_operation_start_times_v3.sql
	schemaV3SQL string
	//go:embed 0004_model_usage_v4.sql
	schemaV4SQL string
)

type Migration struct {
	Version           int
	Name              string
	Checksum          string
	TargetUserVersion int
	SQL               string
}

type State string

const (
	StateUpToDate State = "up_to_date"
	StatePending  State = "pending"
	StateBlocked  State = "blocked"
)

type TargetKind string

const (
	TargetTemporary    TargetKind = "temporary"
	TargetDatabaseCopy TargetKind = "database-copy"
)

type Status struct {
	State      State `json:"state"`
	Registered int   `json:"registered"`
}

type Registry struct {
	catalog    Catalog
	migrations []Migration
	err        error
}

// NewRegistry preserves the P02 metadata argument while installing the
// immutable production schema registry introduced by P04.
func NewRegistry(catalog Catalog) Registry {
	registry := Registry{
		catalog: catalog,
		migrations: []Migration{
			{
				Version: SchemaV1Version, Name: SchemaV1Name,
				Checksum: SchemaV1Checksum, TargetUserVersion: SchemaV1UserVersion,
				SQL: canonicalMigrationSQL(schemaV1SQL),
			},
			{
				Version: SchemaV2Version, Name: SchemaV2Name,
				Checksum: SchemaV2Checksum, TargetUserVersion: SchemaV2UserVersion,
				SQL: canonicalMigrationSQL(schemaV2SQL),
			},
			{
				Version: SchemaV3Version, Name: SchemaV3Name,
				Checksum: SchemaV3Checksum, TargetUserVersion: SchemaV3UserVersion,
				SQL: canonicalMigrationSQL(schemaV3SQL),
			},
			{
				Version: SchemaV4Version, Name: SchemaV4Name,
				Checksum: SchemaV4Checksum, TargetUserVersion: SchemaV4UserVersion,
				SQL: canonicalMigrationSQL(schemaV4SQL),
			},
		},
	}
	registry.err = validateMigrations(registry.migrations)
	return registry
}

// canonicalMigrationSQL preserves the byte representation used by the
// immutable migration checksums. go:embed keeps checkout line endings, so a
// Windows CRLF checkout and a GitHub Actions LF checkout must be normalized
// before validation and execution.
func canonicalMigrationSQL(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.ReplaceAll(value, "\r", "\n")
}

func (registry Registry) Migrations() []Migration {
	return append([]Migration(nil), registry.migrations...)
}

func (registry Registry) Validate() error {
	return registry.err
}

func (registry Registry) LatestVersion() int {
	if len(registry.migrations) == 0 {
		return 0
	}
	return registry.migrations[len(registry.migrations)-1].TargetUserVersion
}

// Inspect remains metadata-only. Once a production migration is registered,
// a target is pending until the database-aware runner proves otherwise.
func (registry Registry) Inspect(target string, kind TargetKind) Status {
	entries := registry.migrations
	status := Status{State: StateBlocked, Registered: len(entries)}
	if registry.err != nil || target == "" || !filepath.IsAbs(target) {
		return status
	}
	switch kind {
	case TargetTemporary:
		// Filesystem containment is enforced by the instance/runtime gates.
	case TargetDatabaseCopy:
		base := strings.ToLower(filepath.Base(filepath.Clean(target)))
		if base == "autoplan.sqlite" || !(strings.HasSuffix(base, ".copy") ||
			strings.HasSuffix(base, ".backup") || strings.HasSuffix(base, ".bak")) {
			return status
		}
	default:
		return status
	}
	if len(entries) != 0 {
		status.State = StatePending
		return status
	}
	status.State = StateUpToDate
	return status
}

func (status Status) AllowedForStartup() bool {
	return status.State == StateUpToDate && status.Registered == 0
}

func validateMigrations(entries []Migration) error {
	if len(entries) == 0 {
		return fmt.Errorf("%w: empty", ErrInvalidRegistry)
	}
	ordered := append([]Migration(nil), entries...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Version < ordered[j].Version })
	for index, entry := range ordered {
		expected := index + 1
		if entry.Version != expected || entry.TargetUserVersion != entry.Version ||
			entry.Name == "" || strings.TrimSpace(entry.SQL) == "" ||
			entry.Checksum == "" {
			return fmt.Errorf("%w: invalid_entry", ErrInvalidRegistry)
		}
		if index > 0 && ordered[index-1].Version == entry.Version {
			return fmt.Errorf("%w: duplicate_version", ErrInvalidRegistry)
		}
		digest := sha256.Sum256([]byte(entry.SQL))
		if hex.EncodeToString(digest[:]) != entry.Checksum {
			return fmt.Errorf("%w: checksum_mismatch", ErrInvalidRegistry)
		}
	}
	return nil
}
