package httpapi

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticRESTContractUsesBoundedCanonicalPagination(t *testing.T) {
	valid, err := url.Parse("http://fixture.invalid/api/v1/projects/7/scripts?limit=200&offset=0")
	if err != nil {
		t.Fatal(err)
	}
	limit, offset, failure := automationPagination(valid)
	if failure != nil || limit != 200 || offset != 0 {
		t.Fatalf("valid pagination limit=%d offset=%d failure=%#v", limit, offset, failure)
	}
	invalid, err := url.Parse("http://fixture.invalid/api/v1/projects/7/scripts?limit=201")
	if err != nil {
		t.Fatal(err)
	}
	_, _, failure = automationPagination(invalid)
	if failure == nil || failure.Code() != CodeInvalidPagination {
		t.Fatalf("oversized pagination failure=%#v", failure)
	}
	if _, valid := parseVersionMap([]int64{7, 7}, map[string]int64{"7": 1}); valid {
		t.Fatal("duplicate reorder ids must be rejected before a write")
	}
}

func TestStaticRESTContractDocumentsOnlyStaticPersistenceRoutes(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	openAPI, err := os.ReadFile(filepath.Join(root, "openapi", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(openAPI)
	for _, route := range []string{
		PlansPath,
		ProjectScriptsPath, ProjectExecutorsPath, ProjectConversationsPath, ProjectMessagesPath,
		AIConfigsPath, ClaudeCLIConfigsPath, MCPConfigPath,
	} {
		if !strings.Contains(text, route+":") {
			t.Fatalf("OpenAPI is missing static route %q", route)
		}
	}
	for _, statement := range []string{
		"operationId: deletePlan", "#/components/schemas/PlanDeleteRequest",
		"#/components/schemas/PlanMutationEnvelope", "#/components/parameters/IdempotencyKey",
	} {
		if !strings.Contains(text, statement) {
			t.Fatalf("OpenAPI plan deletion contract is missing %q", statement)
		}
	}
	for _, statement := range []string{
		"without running it", "without starting a transport", "without raw secret", "not_implemented",
	} {
		if !strings.Contains(text, statement) {
			t.Fatalf("OpenAPI runtime/secret closure is missing %q", statement)
		}
	}
}
