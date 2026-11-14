// Command terraform-provider-asterius is the Terraform / OpenTofu provider of the Asterius Platform.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/provider"
)

// version is set by the release build (goreleaser: -X main.version=…).
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/asteriusit/asterius",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
