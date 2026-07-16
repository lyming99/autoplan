// Package migrations is the explicit registration boundary for versioned
// migrations. P10 adds the durable Operation/outbox schema as v2 history and
// v3 repairs the start boundary of synchronous idempotency operations and v4
// adds provider-neutral token accounting.
package migrations

// Descriptor is safe metadata for a future migration implementation.
type Descriptor struct {
	ID          string `json:"id"`
	Description string `json:"description"`
}

// Catalog is immutable after construction so command parsing cannot register
// arbitrary migration behavior.
type Catalog struct {
	entries []Descriptor
}

// NewCatalog returns immutable metadata for the registered migration history.
func NewCatalog() Catalog {
	return Catalog{entries: []Descriptor{
		{ID: "operations-outbox-v2", Description: "P10 Operation, project revision, and event outbox contract"},
		{ID: "operation-start-times-v3", Description: "Repair synchronous idempotency operation start timestamps"},
		{ID: "model-usage-v4", Description: "Provider-neutral model token accounting"},
	}}
}

// Entries returns a copy of registered metadata.
func (catalog Catalog) Entries() []Descriptor {
	return append([]Descriptor(nil), catalog.entries...)
}
