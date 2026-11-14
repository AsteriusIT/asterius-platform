package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/attr/xattr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// JSONType is a string attribute holding a JSON document (write it with jsonencode()).
//
// Semantic equality: a new value read from the API equals the prior value (configuration or state) when the prior
// document is contained in it: same scalars, every key of a prior object present with a contained value, arrays of the
// same length with contained elements. The API fills defaults into nested documents (e.g. `query: {}` in a connector
// request); keys the configuration does not set are therefore not a difference, and plans do not churn. Formatting
// and key order are never a difference.
type JSONType struct{ basetypes.StringType }

var (
	_ basetypes.StringTypable                    = JSONType{}
	_ basetypes.StringValuableWithSemanticEquals = JSONValue{}
	_ xattr.ValidateableAttribute                = JSONValue{}
)

func (t JSONType) Equal(o attr.Type) bool { _, ok := o.(JSONType); return ok }
func (t JSONType) String() string         { return "provider.JSONType" }
func (t JSONType) ValueType(context.Context) attr.Value {
	return JSONValue{}
}

func (t JSONType) ValueFromString(_ context.Context, in basetypes.StringValue) (basetypes.StringValuable, diag.Diagnostics) {
	return JSONValue{StringValue: in}, nil
}

func (t JSONType) ValueFromTerraform(ctx context.Context, in tftypes.Value) (attr.Value, error) {
	v, err := t.StringType.ValueFromTerraform(ctx, in)
	if err != nil {
		return nil, err
	}
	s, ok := v.(basetypes.StringValue)
	if !ok {
		return nil, fmt.Errorf("unexpected value type %T", v)
	}
	return JSONValue{StringValue: s}, nil
}

// JSONValue is a value of JSONType.
type JSONValue struct{ basetypes.StringValue }

func (v JSONValue) Type(context.Context) attr.Type { return JSONType{} }

func (v JSONValue) Equal(o attr.Value) bool {
	other, ok := o.(JSONValue)
	return ok && v.StringValue.Equal(other.StringValue)
}

// StringSemanticEquals: the framework calls it on the new value (read from the API) with the prior value (plan or
// state) as the argument; true keeps the prior value.
func (v JSONValue) StringSemanticEquals(_ context.Context, priorValuable basetypes.StringValuable) (bool, diag.Diagnostics) {
	var diags diag.Diagnostics
	pv, ok := priorValuable.(JSONValue)
	if !ok {
		return false, diags
	}
	var prior, next any
	if err := decodeJSON(pv.ValueString(), &prior); err != nil {
		return false, diags
	}
	if err := decodeJSON(v.ValueString(), &next); err != nil {
		return false, diags
	}
	return jsonContains(next, prior), diags
}

func (v JSONValue) ValidateAttribute(_ context.Context, req xattr.ValidateAttributeRequest, resp *xattr.ValidateAttributeResponse) {
	if v.IsNull() || v.IsUnknown() {
		return
	}
	var out any
	if err := decodeJSON(v.ValueString(), &out); err != nil {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid JSON", "The value must be a JSON document (use jsonencode()): "+err.Error())
	}
}

// NewJSONValue returns a known value.
func NewJSONValue(s string) JSONValue { return JSONValue{StringValue: basetypes.NewStringValue(s)} }

// NewJSONNull returns a null value.
func NewJSONNull() JSONValue { return JSONValue{StringValue: basetypes.NewStringNull()} }

// NewJSONUnknown returns an unknown value.
func NewJSONUnknown() JSONValue { return JSONValue{StringValue: basetypes.NewStringUnknown()} }

func decodeJSON(s string, out *any) error {
	d := json.NewDecoder(bytes.NewReader([]byte(s)))
	d.UseNumber()
	if err := d.Decode(out); err != nil {
		return err
	}
	if d.More() {
		return fmt.Errorf("trailing data after the JSON document")
	}
	return nil
}

// normalizeJSON re-encodes a document compactly with sorted object keys (encoding/json sorts map keys).
func normalizeJSON(raw []byte) (string, error) {
	var v any
	if err := decodeJSON(string(raw), &v); err != nil {
		return "", err
	}
	out, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// jsonContains reports whether `prior` is contained in `next` (see JSONType).
func jsonContains(next, prior any) bool {
	switch p := prior.(type) {
	case map[string]any:
		n, ok := next.(map[string]any)
		if !ok {
			return false
		}
		for k, pv := range p {
			nv, present := n[k]
			if !present {
				// The API leaves null fields out.
				if pv == nil {
					continue
				}
				return false
			}
			if !jsonContains(nv, pv) {
				return false
			}
		}
		return true
	case []any:
		n, ok := next.([]any)
		if !ok || len(n) != len(p) {
			return false
		}
		for i := range p {
			if !jsonContains(n[i], p[i]) {
				return false
			}
		}
		return true
	case json.Number:
		n, ok := next.(json.Number)
		if !ok {
			return false
		}
		if p == n {
			return true
		}
		pf, err1 := p.Float64()
		nf, err2 := n.Float64()
		return err1 == nil && err2 == nil && pf == nf
	default:
		return prior == next
	}
}
