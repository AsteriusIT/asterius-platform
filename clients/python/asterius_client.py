"""Asterius Platform API client. Generated from docs/openapi.json (version 0.1.0) by `npm run clients:generate`. Do not edit.

Usage:
    client = AsteriusClient("https://portal.example.com", token="...")
    client.put_integrations_by_id("cmdb", {...})
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class ApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.body = body


class AsteriusClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, query: Optional[dict] = None, body: Any = None) -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        data = json.dumps(body).encode() if body is not None else None
        headers = {"authorization": f"Bearer {self.token}", "accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                text = res.read().decode()
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            parsed = json.loads(text) if text else None
            raise ApiError(err.code, (parsed or {}).get("error", err.reason) if isinstance(parsed, dict) else err.reason, parsed) from err
        return json.loads(text) if text else None

    def get_descriptor_schema_json(self, query: Optional[dict] = None) -> Any:
        """GET /api/descriptor-schema.json"""
        return self._request("GET", f"/api/descriptor-schema.json", query)

    def delete_mcp(self, query: Optional[dict] = None) -> Any:
        """DELETE /api/mcp"""
        return self._request("DELETE", f"/api/mcp", query)

    def get_mcp(self, query: Optional[dict] = None) -> Any:
        """GET /api/mcp"""
        return self._request("GET", f"/api/mcp", query)

    def post_mcp(self, query: Optional[dict] = None) -> Any:
        """POST /api/mcp"""
        return self._request("POST", f"/api/mcp", query)

    def get_meta(self, query: Optional[dict] = None) -> Any:
        """GET /api/meta"""
        return self._request("GET", f"/api/meta", query)

    def get_orgs(self, query: Optional[dict] = None) -> Any:
        """GET /api/orgs"""
        return self._request("GET", f"/api/orgs", query)

    def post_orgs(self, query: Optional[dict] = None) -> Any:
        """POST /api/orgs"""
        return self._request("POST", f"/api/orgs", query)

    def delete_orgs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/orgs/{id}"""
        return self._request("DELETE", f"/api/orgs/{urllib.parse.quote(id, safe='')}", query)

    def get_actions(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/actions"""
        return self._request("GET", f"/api/v1/actions", query)

    def delete_actions_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/actions/{id}"""
        return self._request("DELETE", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}", query)

    def get_actions_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/actions/{id}"""
        return self._request("GET", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}", query)

    def put_actions_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/actions/{id}"""
        return self._request("PUT", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}", query, body)

    def get_actions_diff_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/actions/{id}/diff"""
        return self._request("GET", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/diff", query)

    def post_actions_dry_run_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/{id}/dry-run"""
        return self._request("POST", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/dry-run", query)

    def post_actions_rollback_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/{id}/rollback"""
        return self._request("POST", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/rollback", query)

    def post_actions_runs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/{id}/runs"""
        return self._request("POST", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/runs", query)

    def post_actions_tests_run_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/{id}/tests/run"""
        return self._request("POST", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/tests/run", query)

    def get_actions_versions_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/actions/{id}/versions"""
        return self._request("GET", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/versions", query)

    def get_actions_versions_by_id_version(self, id: str, version: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/actions/{id}/versions/{version}"""
        return self._request("GET", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/versions/{urllib.parse.quote(version, safe='')}", query)

    def post_actions_dry_run(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/dry-run"""
        return self._request("POST", f"/api/v1/actions/dry-run", query)

    def post_ai_ask(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/ask"""
        return self._request("POST", f"/api/v1/ai/ask", query)

    def get_ai_budgets(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/budgets"""
        return self._request("GET", f"/api/v1/ai/budgets", query)

    def put_ai_budgets(self, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/ai/budgets"""
        return self._request("PUT", f"/api/v1/ai/budgets", query)

    def delete_ai_budgets_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/ai/budgets/{id}"""
        return self._request("DELETE", f"/api/v1/ai/budgets/{urllib.parse.quote(id, safe='')}", query)

    def post_ai_draft_blueprint(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/draft-blueprint"""
        return self._request("POST", f"/api/v1/ai/draft-blueprint", query)

    def post_ai_draft_workflow(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/draft-workflow"""
        return self._request("POST", f"/api/v1/ai/draft-workflow", query)

    def get_ai_prices(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/prices"""
        return self._request("GET", f"/api/v1/ai/prices", query)

    def delete_ai_prices_by_model(self, model: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/ai/prices/{model}"""
        return self._request("DELETE", f"/api/v1/ai/prices/{urllib.parse.quote(model, safe='')}", query)

    def put_ai_prices_by_model(self, model: str, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/ai/prices/{model}"""
        return self._request("PUT", f"/api/v1/ai/prices/{urllib.parse.quote(model, safe='')}", query)

    def get_ai_reviews(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/reviews"""
        return self._request("GET", f"/api/v1/ai/reviews", query)

    def get_ai_reviews_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/reviews/{id}"""
        return self._request("GET", f"/api/v1/ai/reviews/{urllib.parse.quote(id, safe='')}", query)

    def post_ai_reviews_run(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/reviews/run"""
        return self._request("POST", f"/api/v1/ai/reviews/run", query)

    def post_ai_runs_explain_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/runs/{id}/explain"""
        return self._request("POST", f"/api/v1/ai/runs/{urllib.parse.quote(id, safe='')}/explain", query)

    def get_ai_status(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/status"""
        return self._request("GET", f"/api/v1/ai/status", query)

    def post_ai_suggest_mapping(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/ai/suggest-mapping"""
        return self._request("POST", f"/api/v1/ai/suggest-mapping", query)

    def get_ai_usage(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/ai/usage"""
        return self._request("GET", f"/api/v1/ai/usage", query)

    def get_approvals(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/approvals"""
        return self._request("GET", f"/api/v1/approvals", query)

    def get_archive(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/archive"""
        return self._request("GET", f"/api/v1/archive", query)

    def post_archive_import(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/archive/import"""
        return self._request("POST", f"/api/v1/archive/import", query)

    def get_audit(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/audit"""
        return self._request("GET", f"/api/v1/audit", query)

    def get_audit_export(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/audit/export"""
        return self._request("GET", f"/api/v1/audit/export", query)

    def get_audit_facets(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/audit/facets"""
        return self._request("GET", f"/api/v1/audit/facets", query)

    def get_audit_verify(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/audit/verify"""
        return self._request("GET", f"/api/v1/audit/verify", query)

    def get_blueprints(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints"""
        return self._request("GET", f"/api/v1/blueprints", query)

    def delete_blueprints_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/blueprints/{bp}"""
        return self._request("DELETE", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}", query)

    def get_blueprints_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}", query)

    def put_blueprints_by_bp(self, bp: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/blueprints/{bp}"""
        return self._request("PUT", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}", query, body)

    def get_blueprints_entities_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities", query)

    def post_blueprints_entities_by_bp(self, bp: str, body: dict, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities", query, body)

    def delete_blueprints_entities_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/blueprints/{bp}/entities/{id}"""
        return self._request("DELETE", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}", query)

    def get_blueprints_entities_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}", query)

    def patch_blueprints_entities_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/blueprints/{bp}/entities/{id}"""
        return self._request("PATCH", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}", query)

    def put_blueprints_entities_by_bp_id(self, bp: str, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/blueprints/{bp}/entities/{id}"""
        return self._request("PUT", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}", query, body)

    def get_blueprints_entities_actions_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/actions"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/actions", query)

    def get_blueprints_entities_docs_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/docs"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/docs", query)

    def get_blueprints_entities_graph_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/graph"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/graph", query)

    def get_blueprints_entities_history_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/history"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/history", query)

    def post_blueprints_entities_history_revert_by_bp_id_version(self, bp: str, id: str, version: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities/{id}/history/{version}/revert"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/history/{urllib.parse.quote(version, safe='')}/revert", query)

    def get_blueprints_entities_related_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/related"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/related", query)

    def post_blueprints_entities_restore_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities/{id}/restore"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/restore", query)

    def get_blueprints_entities_scorecards_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/scorecards"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/scorecards", query)

    def post_blueprints_entities_bulk_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities/bulk"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/bulk", query)

    def post_blueprints_entities_query_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities/query"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/query", query)

    def post_blueprints_impact_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/impact"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/impact", query)

    def post_blueprints_migrate_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/migrate"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/migrate", query)

    def post_blueprints_repair_relations_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/repair-relations"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/repair-relations", query)

    def get_blueprints_scorecard_levels_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/scorecard-levels"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/scorecard-levels", query)

    def get_blueprints_validation_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/validation"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/validation", query)

    def get_config(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config"""
        return self._request("GET", f"/api/v1/config", query)

    def get_config_diff(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/diff"""
        return self._request("GET", f"/api/v1/config/diff", query)

    def get_config_export(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/export"""
        return self._request("GET", f"/api/v1/config/export", query)

    def post_config_import(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/config/import"""
        return self._request("POST", f"/api/v1/config/import", query)

    def get_config_plan(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/plan"""
        return self._request("GET", f"/api/v1/config/plan", query)

    def post_config_reload(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/config/reload"""
        return self._request("POST", f"/api/v1/config/reload", query)

    def get_config_status(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/status"""
        return self._request("GET", f"/api/v1/config/status", query)

    def get_dashboards(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/dashboards"""
        return self._request("GET", f"/api/v1/dashboards", query)

    def delete_dashboards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/dashboards/{id}"""
        return self._request("DELETE", f"/api/v1/dashboards/{urllib.parse.quote(id, safe='')}", query)

    def get_dashboards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/dashboards/{id}"""
        return self._request("GET", f"/api/v1/dashboards/{urllib.parse.quote(id, safe='')}", query)

    def put_dashboards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/dashboards/{id}"""
        return self._request("PUT", f"/api/v1/dashboards/{urllib.parse.quote(id, safe='')}", query)

    def get_dashboards_data_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/dashboards/{id}/data"""
        return self._request("GET", f"/api/v1/dashboards/{urllib.parse.quote(id, safe='')}/data", query)

    def get_dashboards_resolve(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/dashboards/resolve"""
        return self._request("GET", f"/api/v1/dashboards/resolve", query)

    def get_delegations(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/delegations"""
        return self._request("GET", f"/api/v1/delegations", query)

    def delete_delegations_by_user_id(self, user_id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/delegations/{userId}"""
        return self._request("DELETE", f"/api/v1/delegations/{urllib.parse.quote(user_id, safe='')}", query)

    def get_deleted_entities(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/deleted-entities"""
        return self._request("GET", f"/api/v1/deleted-entities", query)

    def delete_deleted_entities_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/deleted-entities/{bp}/{id}"""
        return self._request("DELETE", f"/api/v1/deleted-entities/{urllib.parse.quote(bp, safe='')}/{urllib.parse.quote(id, safe='')}", query)

    def get_deliveries(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/deliveries"""
        return self._request("GET", f"/api/v1/deliveries", query)

    def post_deliveries_redeliver_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/deliveries/{id}/redeliver"""
        return self._request("POST", f"/api/v1/deliveries/{urllib.parse.quote(id, safe='')}/redeliver", query)

    def post_deliveries_redeliver(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/deliveries/redeliver"""
        return self._request("POST", f"/api/v1/deliveries/redeliver", query)

    def post_deliveries_redeliver_failed(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/deliveries/redeliver-failed"""
        return self._request("POST", f"/api/v1/deliveries/redeliver-failed", query)

    def get_entities(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/entities"""
        return self._request("GET", f"/api/v1/entities", query)

    def get_entities_graph_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/entities/{bp}/{id}/graph"""
        return self._request("GET", f"/api/v1/entities/{urllib.parse.quote(bp, safe='')}/{urllib.parse.quote(id, safe='')}/graph", query)

    def get_entities_history_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/entities/{bp}/{id}/history"""
        return self._request("GET", f"/api/v1/entities/{urllib.parse.quote(bp, safe='')}/{urllib.parse.quote(id, safe='')}/history", query)

    def post_entities_query(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/entities/query"""
        return self._request("POST", f"/api/v1/entities/query", query)

    def post_expressions_check(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/expressions/check"""
        return self._request("POST", f"/api/v1/expressions/check", query)

    def get_fragments(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/fragments"""
        return self._request("GET", f"/api/v1/fragments", query)

    def delete_fragments_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/fragments/{id}"""
        return self._request("DELETE", f"/api/v1/fragments/{urllib.parse.quote(id, safe='')}", query)

    def get_fragments_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/fragments/{id}"""
        return self._request("GET", f"/api/v1/fragments/{urllib.parse.quote(id, safe='')}", query)

    def put_fragments_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/fragments/{id}"""
        return self._request("PUT", f"/api/v1/fragments/{urllib.parse.quote(id, safe='')}", query, body)

    def get_fragments_usage_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/fragments/{id}/usage"""
        return self._request("GET", f"/api/v1/fragments/{urllib.parse.quote(id, safe='')}/usage", query)

    def get_fragments_versions_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/fragments/{id}/versions"""
        return self._request("GET", f"/api/v1/fragments/{urllib.parse.quote(id, safe='')}/versions", query)

    def get_home(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/home"""
        return self._request("GET", f"/api/v1/home", query)

    def post_hooks_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/hooks/{id}"""
        return self._request("POST", f"/api/v1/hooks/{urllib.parse.quote(id, safe='')}", query)

    def post_hooks_by_org_id(self, org: str, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/hooks/{org}/{id}"""
        return self._request("POST", f"/api/v1/hooks/{urllib.parse.quote(org, safe='')}/{urllib.parse.quote(id, safe='')}", query)

    def get_insights(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/insights"""
        return self._request("GET", f"/api/v1/insights", query)

    def get_integrations(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/integrations"""
        return self._request("GET", f"/api/v1/integrations", query)

    def delete_integrations_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/integrations/{id}"""
        return self._request("DELETE", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}", query)

    def get_integrations_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/integrations/{id}"""
        return self._request("GET", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}", query)

    def put_integrations_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/integrations/{id}"""
        return self._request("PUT", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}", query, body)

    def post_integrations_sync_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/integrations/{id}/sync"""
        return self._request("POST", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}/sync", query)

    def get_integrations_syncs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/integrations/{id}/syncs"""
        return self._request("GET", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}/syncs", query)

    def post_integrations_test_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/integrations/{id}/test"""
        return self._request("POST", f"/api/v1/integrations/{urllib.parse.quote(id, safe='')}/test", query)

    def post_integrations_test(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/integrations/test"""
        return self._request("POST", f"/api/v1/integrations/test", query)

    def post_mappings_preview(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/mappings/preview"""
        return self._request("POST", f"/api/v1/mappings/preview", query)

    def delete_api_v1_mcp(self, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/mcp"""
        return self._request("DELETE", f"/api/v1/mcp", query)

    def get_api_v1_mcp(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/mcp"""
        return self._request("GET", f"/api/v1/mcp", query)

    def post_api_v1_mcp(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/mcp"""
        return self._request("POST", f"/api/v1/mcp", query)

    def delete_me_delegation(self, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/me/delegation"""
        return self._request("DELETE", f"/api/v1/me/delegation", query)

    def get_me_delegation(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/me/delegation"""
        return self._request("GET", f"/api/v1/me/delegation", query)

    def put_me_delegation(self, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/me/delegation"""
        return self._request("PUT", f"/api/v1/me/delegation", query, body)

    def get_me_notifications(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/me/notifications"""
        return self._request("GET", f"/api/v1/me/notifications", query)

    def put_me_notifications(self, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/me/notifications"""
        return self._request("PUT", f"/api/v1/me/notifications", query)

    def get_notification_settings(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/notification-settings"""
        return self._request("GET", f"/api/v1/notification-settings", query)

    def put_notification_settings(self, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/notification-settings"""
        return self._request("PUT", f"/api/v1/notification-settings", query)

    def post_notification_settings_test(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/notification-settings/test"""
        return self._request("POST", f"/api/v1/notification-settings/test", query)

    def get_notifications(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/notifications"""
        return self._request("GET", f"/api/v1/notifications", query)

    def get_notifications_channels(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/notifications/channels"""
        return self._request("GET", f"/api/v1/notifications/channels", query)

    def get_notifications_preferences(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/notifications/preferences"""
        return self._request("GET", f"/api/v1/notifications/preferences", query)

    def put_notifications_preferences(self, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/notifications/preferences"""
        return self._request("PUT", f"/api/v1/notifications/preferences", query)

    def post_notifications_read(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/notifications/read"""
        return self._request("POST", f"/api/v1/notifications/read", query)

    def delete_org(self, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/org"""
        return self._request("DELETE", f"/api/v1/org", query)

    def get_org(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/org"""
        return self._request("GET", f"/api/v1/org", query)

    def patch_org(self, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/org"""
        return self._request("PATCH", f"/api/v1/org", query)

    def put_org_config_source(self, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/org/config-source"""
        return self._request("PUT", f"/api/v1/org/config-source", query)

    def post_org_config_sync(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/org/config/sync"""
        return self._request("POST", f"/api/v1/org/config/sync", query)

    def post_org_domains_verify(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/org/domains/verify"""
        return self._request("POST", f"/api/v1/org/domains/verify", query)

    def get_org_members(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/org/members"""
        return self._request("GET", f"/api/v1/org/members", query)

    def post_org_members(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/org/members"""
        return self._request("POST", f"/api/v1/org/members", query)

    def delete_org_members_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/org/members/{id}"""
        return self._request("DELETE", f"/api/v1/org/members/{urllib.parse.quote(id, safe='')}", query)

    def patch_org_members_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/org/members/{id}"""
        return self._request("PATCH", f"/api/v1/org/members/{urllib.parse.quote(id, safe='')}", query)

    def get_org_sso(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/org/sso"""
        return self._request("GET", f"/api/v1/org/sso", query)

    def post_org_sso_enable(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/org/sso/enable"""
        return self._request("POST", f"/api/v1/org/sso/enable", query)

    def post_org_sso_providers(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/org/sso/providers"""
        return self._request("POST", f"/api/v1/org/sso/providers", query)

    def delete_org_sso_providers_by_alias(self, alias: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/org/sso/providers/{alias}"""
        return self._request("DELETE", f"/api/v1/org/sso/providers/{urllib.parse.quote(alias, safe='')}", query)

    def get_permissions(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/permissions"""
        return self._request("GET", f"/api/v1/permissions", query)

    def get_policies(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/policies"""
        return self._request("GET", f"/api/v1/policies", query)

    def delete_policies_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/policies/{id}"""
        return self._request("DELETE", f"/api/v1/policies/{urllib.parse.quote(id, safe='')}", query)

    def get_policies_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/policies/{id}"""
        return self._request("GET", f"/api/v1/policies/{urllib.parse.quote(id, safe='')}", query)

    def put_policies_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/policies/{id}"""
        return self._request("PUT", f"/api/v1/policies/{urllib.parse.quote(id, safe='')}", query, body)

    def get_runs(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs"""
        return self._request("GET", f"/api/v1/runs", query)

    def get_runs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs/{id}"""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}", query)

    def patch_runs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/runs/{id}"""
        return self._request("PATCH", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}", query)

    def post_runs_approve_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/approve"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/approve", query)

    def get_runs_artifacts_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs/{id}/artifacts"""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/artifacts", query)

    def get_runs_artifacts_by_id_artifact_id(self, id: str, artifact_id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs/{id}/artifacts/{artifactId}"""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/artifacts/{urllib.parse.quote(artifact_id, safe='')}", query)

    def post_runs_cancel_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/cancel"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/cancel", query)

    def get_runs_events_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs/{id}/events"""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/events", query)

    def get_runs_logs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/runs/{id}/logs"""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/logs", query)

    def post_runs_logs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/logs"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/logs", query)

    def post_runs_pause_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/pause"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/pause", query)

    def post_runs_reject_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/reject"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/reject", query)

    def post_runs_rerun_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/rerun"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/rerun", query)

    def post_runs_resume_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/resume"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/resume", query)

    def patch_runs_steps_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/runs/{id}/steps/{step}"""
        return self._request("PATCH", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}", query)

    def post_runs_steps_approve_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/approve"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/approve", query)

    def post_runs_steps_artifacts_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/artifacts"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/artifacts", query)

    def post_runs_steps_complete_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/complete"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/complete", query)

    def post_runs_steps_events_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/events"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/events", query)

    def post_runs_steps_input_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/input"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/input", query)

    def post_runs_steps_logs_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/logs"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/logs", query)

    def post_runs_steps_reject_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/reject"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/reject", query)

    def post_runs_steps_retry_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/retry"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/retry", query)

    def post_runs_steps_skip_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/skip"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/skip", query)

    def post_runs_unpause_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/unpause"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/unpause", query)

    def post_scim_token(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/scim/token"""
        return self._request("POST", f"/api/v1/scim/token", query)

    def get_scorecards(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/scorecards"""
        return self._request("GET", f"/api/v1/scorecards", query)

    def delete_scorecards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/scorecards/{id}"""
        return self._request("DELETE", f"/api/v1/scorecards/{urllib.parse.quote(id, safe='')}", query)

    def get_scorecards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/scorecards/{id}"""
        return self._request("GET", f"/api/v1/scorecards/{urllib.parse.quote(id, safe='')}", query)

    def put_scorecards_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/scorecards/{id}"""
        return self._request("PUT", f"/api/v1/scorecards/{urllib.parse.quote(id, safe='')}", query)

    def post_scorecards_evaluate_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/scorecards/{id}/evaluate"""
        return self._request("POST", f"/api/v1/scorecards/{urllib.parse.quote(id, safe='')}/evaluate", query)

    def get_scorecards_summary_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/scorecards/{id}/summary"""
        return self._request("GET", f"/api/v1/scorecards/{urllib.parse.quote(id, safe='')}/summary", query)

    def get_secret_providers(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/secret-providers"""
        return self._request("GET", f"/api/v1/secret-providers", query)

    def get_secrets(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/secrets"""
        return self._request("GET", f"/api/v1/secrets", query)

    def delete_secrets_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/secrets/{id}"""
        return self._request("DELETE", f"/api/v1/secrets/{urllib.parse.quote(id, safe='')}", query)

    def put_secrets_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/secrets/{id}"""
        return self._request("PUT", f"/api/v1/secrets/{urllib.parse.quote(id, safe='')}", query)

    def post_secrets_reencrypt(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/secrets/reencrypt"""
        return self._request("POST", f"/api/v1/secrets/reencrypt", query)

    def post_service_accounts(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/service-accounts"""
        return self._request("POST", f"/api/v1/service-accounts", query)

    def get_teams(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/teams"""
        return self._request("GET", f"/api/v1/teams", query)

    def delete_teams_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/teams/{id}"""
        return self._request("DELETE", f"/api/v1/teams/{urllib.parse.quote(id, safe='')}", query)

    def put_teams_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/teams/{id}"""
        return self._request("PUT", f"/api/v1/teams/{urllib.parse.quote(id, safe='')}", query, body)

    def get_tokens(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/tokens"""
        return self._request("GET", f"/api/v1/tokens", query)

    def post_tokens(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/tokens"""
        return self._request("POST", f"/api/v1/tokens", query)

    def delete_tokens_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/tokens/{id}"""
        return self._request("DELETE", f"/api/v1/tokens/{urllib.parse.quote(id, safe='')}", query)

    def get_users(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/users"""
        return self._request("GET", f"/api/v1/users", query)

    def patch_users_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/users/{id}"""
        return self._request("PATCH", f"/api/v1/users/{urllib.parse.quote(id, safe='')}", query)

    def get_users_lookup(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/users/lookup"""
        return self._request("GET", f"/api/v1/users/lookup", query)

    def get_webhooks(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/webhooks"""
        return self._request("GET", f"/api/v1/webhooks", query)

    def delete_webhooks_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/webhooks/{id}"""
        return self._request("DELETE", f"/api/v1/webhooks/{urllib.parse.quote(id, safe='')}", query)

    def get_webhooks_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/webhooks/{id}"""
        return self._request("GET", f"/api/v1/webhooks/{urllib.parse.quote(id, safe='')}", query)

    def put_webhooks_by_id(self, id: str, body: dict, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/webhooks/{id}"""
        return self._request("PUT", f"/api/v1/webhooks/{urllib.parse.quote(id, safe='')}", query, body)

    def get_webhooks_deliveries_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/webhooks/{id}/deliveries"""
        return self._request("GET", f"/api/v1/webhooks/{urllib.parse.quote(id, safe='')}/deliveries", query)

    def post_webhooks_test_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/webhooks/{id}/test"""
        return self._request("POST", f"/api/v1/webhooks/{urllib.parse.quote(id, safe='')}/test", query)
