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

    def get_meta(self, query: Optional[dict] = None) -> Any:
        """GET /api/meta"""
        return self._request("GET", f"/api/meta", query)

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

    def post_actions_runs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/actions/{id}/runs"""
        return self._request("POST", f"/api/v1/actions/{urllib.parse.quote(id, safe='')}/runs", query)

    def get_approvals(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/approvals"""
        return self._request("GET", f"/api/v1/approvals", query)

    def get_audit(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/audit"""
        return self._request("GET", f"/api/v1/audit", query)

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

    def get_blueprints_entities_related_by_bp_id(self, bp: str, id: str, query: Optional[dict] = None) -> Any:
        """GET /api/v1/blueprints/{bp}/entities/{id}/related"""
        return self._request("GET", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/{urllib.parse.quote(id, safe='')}/related", query)

    def post_blueprints_entities_bulk_by_bp(self, bp: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/blueprints/{bp}/entities/bulk"""
        return self._request("POST", f"/api/v1/blueprints/{urllib.parse.quote(bp, safe='')}/entities/bulk", query)

    def get_config(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config"""
        return self._request("GET", f"/api/v1/config", query)

    def get_config_export(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/export"""
        return self._request("GET", f"/api/v1/config/export", query)

    def get_config_plan(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/plan"""
        return self._request("GET", f"/api/v1/config/plan", query)

    def post_config_reload(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/config/reload"""
        return self._request("POST", f"/api/v1/config/reload", query)

    def get_config_status(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/config/status"""
        return self._request("GET", f"/api/v1/config/status", query)

    def get_deliveries(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/deliveries"""
        return self._request("GET", f"/api/v1/deliveries", query)

    def post_deliveries_redeliver_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/deliveries/{id}/redeliver"""
        return self._request("POST", f"/api/v1/deliveries/{urllib.parse.quote(id, safe='')}/redeliver", query)

    def post_deliveries_redeliver_failed(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/deliveries/redeliver-failed"""
        return self._request("POST", f"/api/v1/deliveries/redeliver-failed", query)

    def get_entities(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/entities"""
        return self._request("GET", f"/api/v1/entities", query)

    def get_home(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/home"""
        return self._request("GET", f"/api/v1/home", query)

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

    def post_mappings_preview(self, query: Optional[dict] = None) -> Any:
        """POST /api/v1/mappings/preview"""
        return self._request("POST", f"/api/v1/mappings/preview", query)

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

    def post_runs_cancel_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/cancel"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/cancel", query)

    def post_runs_logs_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/logs"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/logs", query)

    def post_runs_reject_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/reject"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/reject", query)

    def patch_runs_steps_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """PATCH /api/v1/runs/{id}/steps/{step}"""
        return self._request("PATCH", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}", query)

    def post_runs_steps_approve_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/approve"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/approve", query)

    def post_runs_steps_logs_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/logs"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/logs", query)

    def post_runs_steps_reject_by_id_step(self, id: str, step: str, query: Optional[dict] = None) -> Any:
        """POST /api/v1/runs/{id}/steps/{step}/reject"""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(id, safe='')}/steps/{urllib.parse.quote(step, safe='')}/reject", query)

    def get_secrets(self, query: Optional[dict] = None) -> Any:
        """GET /api/v1/secrets"""
        return self._request("GET", f"/api/v1/secrets", query)

    def delete_secrets_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """DELETE /api/v1/secrets/{id}"""
        return self._request("DELETE", f"/api/v1/secrets/{urllib.parse.quote(id, safe='')}", query)

    def put_secrets_by_id(self, id: str, query: Optional[dict] = None) -> Any:
        """PUT /api/v1/secrets/{id}"""
        return self._request("PUT", f"/api/v1/secrets/{urllib.parse.quote(id, safe='')}", query)

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
