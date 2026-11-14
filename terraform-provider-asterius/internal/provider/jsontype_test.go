package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr/xattr"
	"github.com/hashicorp/terraform-plugin-framework/path"
)

func TestJSONContains(t *testing.T) {
	cases := []struct {
		name        string
		next, prior string
		want        bool
	}{
		{"identical", `{"a":1}`, `{"a":1}`, true},
		{"key order and spacing", `{"b":[1,2],"a":"x"}`, `{ "a": "x", "b": [1, 2] }`, true},
		{"defaults added by the API", `{"a":1,"query":{},"headers":{}}`, `{"a":1}`, true},
		{"nested defaults", `[{"id":"run","retries":0,"invoker":{"type":"catalog","x":1}}]`, `[{"id":"run","invoker":{"type":"catalog"}}]`, true},
		{"changed value", `{"a":2}`, `{"a":1}`, false},
		{"removed key", `{}`, `{"a":1}`, false},
		{"null left out by the API", `{}`, `{"a":null}`, true},
		{"array length", `[1,2,3]`, `[1,2]`, false},
		{"array order", `[2,1]`, `[1,2]`, false},
		{"number forms", `{"a":1.0}`, `{"a":1}`, true},
		{"type change", `{"a":"1"}`, `{"a":1}`, false},
		{"object vs array", `[]`, `{}`, false},
		{"empty prior object", `{"properties":{}}`, `{}`, true},
		{"scalars", `"x"`, `"x"`, true},
		{"booleans", `{"a":false}`, `{"a":true}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, diags := NewJSONValue(c.next).StringSemanticEquals(context.Background(), NewJSONValue(c.prior))
			if diags.HasError() {
				t.Fatal(diags)
			}
			if got != c.want {
				t.Fatalf("contains(%s, %s) = %v, want %v", c.next, c.prior, got, c.want)
			}
		})
	}
}

func TestJSONSemanticEqualsInvalid(t *testing.T) {
	got, _ := NewJSONValue(`{"a":1}`).StringSemanticEquals(context.Background(), NewJSONValue(`{bad`))
	if got {
		t.Fatal("an invalid prior document is never equal")
	}
}

func TestNormalizeJSON(t *testing.T) {
	got, err := normalizeJSON([]byte(` { "b": [1, {"d": true, "c": null}], "a": "<x>", "n": 12345678901234567890 } `))
	if err != nil {
		t.Fatal(err)
	}
	// Sorted keys, compact, numbers kept as written; HTML characters escaped like Terraform's jsonencode().
	want := "{\"a\":\"\\u003cx\\u003e\",\"b\":[1,{\"c\":null,\"d\":true}],\"n\":12345678901234567890}"
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if _, err := normalizeJSON([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing data must be refused")
	}
}

func TestJSONValidate(t *testing.T) {
	for doc, ok := range map[string]bool{`{"a":1}`: true, `[]`: true, `{a:1}`: false, ``: false} {
		resp := &xattr.ValidateAttributeResponse{}
		NewJSONValue(doc).ValidateAttribute(context.Background(), xattr.ValidateAttributeRequest{Path: path.Root("x")}, resp)
		if resp.Diagnostics.HasError() == ok {
			t.Errorf("%q: valid=%v, diagnostics %v", doc, ok, resp.Diagnostics)
		}
	}
	resp := &xattr.ValidateAttributeResponse{}
	NewJSONNull().ValidateAttribute(context.Background(), xattr.ValidateAttributeRequest{}, resp)
	NewJSONUnknown().ValidateAttribute(context.Background(), xattr.ValidateAttributeRequest{}, resp)
	if resp.Diagnostics.HasError() {
		t.Fatal("null and unknown values are valid")
	}
}

func TestJSONTypeEquality(t *testing.T) {
	if !NewJSONValue(`{}`).Equal(NewJSONValue(`{}`)) || NewJSONValue(`{}`).Equal(NewJSONValue(`{ }`)) {
		t.Fatal("Equal compares the strings")
	}
	if !(JSONType{}).Equal(JSONType{}) {
		t.Fatal("JSONType equals itself")
	}
}
