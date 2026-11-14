package provider

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/diag"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

const managedDetail = "This resource is declared in the configuration directory of the server (CONFIG_DIR, or the " +
	"organization's configuration repository): it is read-only through the API, which answered 409 Conflict. Change it " +
	"in the configuration files, or remove it from them before managing it with Terraform. Do not manage the same " +
	"identifier from both."

func managedSummary(label string) string {
	return label + " is managed by configuration (CONFIG_DIR)"
}

// addAPIError turns an API error into a diagnostic; `verb` is create, read, write or delete.
func addAPIError(diags *diag.Diagnostics, verb, label string, err error) {
	if client.IsManaged(err) {
		diags.AddError(managedSummary(label), managedDetail+"\n\nAPI answer: "+err.Error())
		return
	}
	var e *client.Error
	if errors.As(err, &e) {
		switch e.Status {
		case http.StatusUnauthorized:
			diags.AddError(fmt.Sprintf("Could not %s %s: unauthorized", verb, label),
				"The API token is missing, invalid or expired (provider `token` or ASTERIUS_TOKEN).\n\n"+err.Error())
			return
		case http.StatusForbidden:
			diags.AddError(fmt.Sprintf("Could not %s %s: %s", verb, label, e.Message),
				"The API answered 403 Forbidden: a policy denied the change, or the token's owner (or the token's scopes) "+
					"may not do this; most resources need an organization admin.\n\n"+err.Error())
			return
		}
	}
	diags.AddError(fmt.Sprintf("Could not %s %s", verb, label), err.Error())
}
