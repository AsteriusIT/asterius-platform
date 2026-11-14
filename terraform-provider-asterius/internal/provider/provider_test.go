package provider

import (
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// testAccProtoV6ProviderFactories runs the provider in process.
var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"asterius": providerserver.NewProtocol6WithError(New("test")()),
}

// testAccPreCheck: acceptance tests (TF_ACC=1) need a server: ASTERIUS_ENDPOINT and ASTERIUS_TOKEN
// (scripts/local-server.sh starts a throwaway one and prints them).
func testAccPreCheck(t *testing.T) {
	t.Helper()
	for _, env := range []string{EnvEndpoint, EnvToken} {
		if os.Getenv(env) == "" {
			t.Fatalf("%s must be set for acceptance tests (see scripts/local-server.sh)", env)
		}
	}
}
