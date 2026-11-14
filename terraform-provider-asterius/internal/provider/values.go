package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// getter is what tfsdk.Plan, tfsdk.State and tfsdk.Config have in common.
type getter interface {
	GetAttribute(ctx context.Context, p path.Path, target any) diag.Diagnostics
}

// setter is what tfsdk.State has.
type setter interface {
	SetAttribute(ctx context.Context, p path.Path, val any) diag.Diagnostics
}

func attrType(k kind) attr.Type {
	switch k {
	case kBool:
		return types.BoolType
	case kInt:
		return types.Int64Type
	case kStringList:
		return types.ListType{ElemType: types.StringType}
	case kStringMap:
		return types.MapType{ElemType: types.StringType}
	case kJSON:
		return JSONType{}
	default:
		return types.StringType
	}
}

func nullOf(k kind) attr.Value {
	switch k {
	case kBool:
		return types.BoolNull()
	case kInt:
		return types.Int64Null()
	case kStringList:
		return types.ListNull(types.StringType)
	case kStringMap:
		return types.MapNull(types.StringType)
	case kJSON:
		return NewJSONNull()
	default:
		return types.StringNull()
	}
}

// getValue reads one attribute as its framework type.
func getValue(ctx context.Context, g getter, f field) (attr.Value, diag.Diagnostics) {
	p := path.Root(f.Name)
	switch f.Kind {
	case kBool:
		var v types.Bool
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	case kInt:
		var v types.Int64
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	case kStringList:
		var v types.List
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	case kStringMap:
		var v types.Map
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	case kJSON:
		var v JSONValue
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	default:
		var v types.String
		d := g.GetAttribute(ctx, p, &v)
		return v, d
	}
}

// toAPI converts a known, non-null value to its JSON form; ok is false for null and unknown values (left out).
func toAPI(ctx context.Context, v attr.Value) (out any, ok bool, diags diag.Diagnostics) {
	if v == nil || v.IsNull() || v.IsUnknown() {
		return nil, false, nil
	}
	switch t := v.(type) {
	case types.String:
		return t.ValueString(), true, nil
	case types.Bool:
		return t.ValueBool(), true, nil
	case types.Int64:
		return t.ValueInt64(), true, nil
	case types.List:
		items := []string{}
		diags = t.ElementsAs(ctx, &items, false)
		return items, true, diags
	case types.Map:
		items := map[string]string{}
		diags = t.ElementsAs(ctx, &items, false)
		return items, true, diags
	case JSONValue:
		var doc any
		if err := decodeJSON(t.ValueString(), &doc); err != nil {
			diags.AddError("Invalid JSON", err.Error())
			return nil, false, diags
		}
		return doc, true, nil
	}
	diags.AddError("Internal error", fmt.Sprintf("unexpected value type %T", v))
	return nil, false, diags
}

// fromAPI converts a property of an API document (absent or null: a null value).
func fromAPI(ctx context.Context, k kind, raw json.RawMessage) (attr.Value, diag.Diagnostics) {
	var diags diag.Diagnostics
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nullOf(k), nil
	}
	bad := func(err error) (attr.Value, diag.Diagnostics) {
		diags.AddError("Unexpected API answer", fmt.Sprintf("cannot read %s: %s", string(raw), err))
		return nullOf(k), diags
	}
	switch k {
	case kBool:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return bad(err)
		}
		return types.BoolValue(b), nil
	case kInt:
		var n json.Number
		if err := json.Unmarshal(raw, &n); err != nil {
			return bad(err)
		}
		i, err := n.Int64()
		if err != nil {
			f, ferr := n.Float64()
			if ferr != nil {
				return bad(err)
			}
			i = int64(f)
		}
		return types.Int64Value(i), nil
	case kStringList:
		var items []string
		if err := json.Unmarshal(raw, &items); err != nil {
			return bad(err)
		}
		if items == nil {
			items = []string{}
		}
		v, d := types.ListValueFrom(ctx, types.StringType, items)
		diags.Append(d...)
		return v, diags
	case kStringMap:
		var items map[string]string
		if err := json.Unmarshal(raw, &items); err != nil {
			return bad(err)
		}
		if items == nil {
			items = map[string]string{}
		}
		v, d := types.MapValueFrom(ctx, types.StringType, items)
		diags.Append(d...)
		return v, diags
	case kJSON:
		s, err := normalizeJSON(raw)
		if err != nil {
			return bad(err)
		}
		return NewJSONValue(s), nil
	default:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return bad(err)
		}
		return types.StringValue(s), nil
	}
}

// isEmpty: null, "", [], {} (and JSON "null", "{}", "[]").
func isEmpty(v attr.Value) bool {
	if v == nil || v.IsNull() {
		return true
	}
	if v.IsUnknown() {
		return false
	}
	switch t := v.(type) {
	case types.String:
		return t.ValueString() == ""
	case types.List:
		return len(t.Elements()) == 0
	case types.Map:
		return len(t.Elements()) == 0
	case JSONValue:
		s := t.ValueString()
		return s == "{}" || s == "[]" || s == "null" || s == ""
	}
	return false
}

// reconcile chooses the value stored for a field: the API's, except that an empty answer keeps the empty value the
// configuration (or the state) has, so `[]`, `{}` and an omitted attribute stay as written.
func reconcile(f field, ref, got attr.Value) attr.Value {
	if f.Computed || !isEmpty(got) {
		return got
	}
	if ref != nil && !ref.IsNull() && !ref.IsUnknown() && isEmpty(ref) {
		return ref
	}
	if f.Nullable {
		return nullOf(f.Kind)
	}
	return got
}
