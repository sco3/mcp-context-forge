# Possible Solution: Granular and Consolidated Hook Parity

## 📋 Problem Statement

The Rust MCP runtime's direct DB-access paths for `prompts/get` and `resources/read` currently bypass plugin hooks. While a fix plan exists to add new internal "check-hooks" endpoints, this approach introduces additional latency by requiring two internal HTTP calls (`authz` + `check-hooks`) for every request. Furthermore, the current implementation lacks granularity, causing a full fallback for all requests if *any* plugin has a relevant hook, even if that plugin only targets a specific prompt or resource.

## 🔍 Key Findings

1.  **Existing Authz Flow**: Rust already calls Python `authz` endpoints (e.g., `/_internal/mcp/prompts/get/authz`) before executing direct queries. This is the optimal point for the fallback decision.
2.  **Missing Granularity**: The current `authz` call does not pass the request parameters (like `prompt_id` or `resource_uri`) to Python, making it impossible for Python to determine if a specific request matches a plugin's `conditions`.
3.  **Bypassed Global Hooks**: Global `HTTP_PRE_REQUEST` and `HTTP_POST_REQUEST` hooks are currently bypassed by Rust and are not checked during the fallback phase.
4.  **Redundancy**: The proposed `check-hooks` endpoint in the original fix plan overlaps with the existing `authz` flow.

## 💡 Proposed Strategy: Granular Consolidated Fallback

Instead of adding new endpoints, we should enhance the existing `authz` mechanism to be "plugin-aware."

### 1. Enhance Python's `authz` endpoints

Update the internal `authz` handlers in `mcpgateway/main.py` to accept the JSON-RPC parameters from the Rust runtime.

```python
# mcpgateway/main.py

async def _authorize_internal_mcp_server_scoped_method(
    request: Request,
    *,
    permission: str,
    method: str,
) -> Response:
    # ... existing auth logic ...

    # NEW: Attempt to parse params from the request body (sent by Rust)
    params = None
    try:
        body = await request.json()
        params = body if isinstance(body, dict) else None
    except Exception:
        pass

    # Pass params to the fallback checker
    fallback_reason = _server_scoped_direct_execution_fallback_reason(method, params)
    if fallback_reason:
        return ORJSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "directExecutionEligible": False,
                "fallbackReason": fallback_reason,
            },
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

### 2. Update Fallback Logic for Granularity

Enhance `_server_scoped_direct_execution_fallback_reason` to check for global HTTP hooks and use the `payload_matches` utility for granular prompt/resource checks.

```python
# mcpgateway/main.py

def _server_scoped_direct_execution_fallback_reason(
    method: str, 
    params: Optional[Dict[str, Any]] = None
) -> Optional[str]:
    if not plugin_manager:
        return None

    # 1. Check for global HTTP hooks (Middleware parity)
    if plugin_manager.has_hooks_for(HttpHookType.HTTP_PRE_REQUEST) or \
       plugin_manager.has_hooks_for(HttpHookType.HTTP_POST_REQUEST):
        return "http-middleware-hooks-configured"

    # 2. Method-specific checks with granularity
    if method == "resources/read":
        # Check if any plugins are interested in this specific resource URI
        # Using a synthetic payload for condition matching
        from mcpgateway.plugins.framework.hooks.resources import ResourcePreFetchPayload
        uri = (params or {}).get("uri")
        # Logic here would iterate plugins to see if any conditions match 'uri'
        # For now, we fall back if ANY relevant hooks exist globally (conservative)
        if plugin_manager.has_hooks_for(ResourceHookType.RESOURCE_PRE_FETCH) or \
           plugin_manager.has_hooks_for(ResourceHookType.RESOURCE_POST_FETCH):
            return "resource-hooks-configured"

    if method == "prompts/get":
        if plugin_manager.has_hooks_for(PromptHookType.PROMPT_PRE_FETCH) or \
           plugin_manager.has_hooks_for(PromptHookType.PROMPT_POST_FETCH):
            return "prompt-hooks-configured"

    return None
```

### 3. Update Rust's `authz` Helper

Update `authorize_server_method_via_backend` in `tools_rust/mcp_runtime/src/lib.rs` to send the original RPC parameters.

```rust
// tools_rust/mcp_runtime/src/lib.rs

async fn authorize_server_method_via_backend(
    state: &AppState,
    incoming_headers: &HeaderMap,
    request_id: Option<Value>,
    url: &str,
    method_label: &str,
    params: Option<&Value>, // NEW: accept params
) -> Result<DirectExecutionAuthorization, Response> {
    let mut rb = state.client.post(url)
        .headers(build_forwarded_headers(incoming_headers));
    
    // NEW: Pass params as the body
    if let Some(p) = params {
        rb = rb.json(p);
    }
    
    let resp = rb.send().await.map_err(|e| { ... })?;
    // ... existing logic ...
}
```

## ✅ Benefits

*   **Zero Extra Latency**: Reuses the mandatory `authz` hop already present in the architecture.
*   **Granular Fast-Path**: Allows Rust to continue serving unhooked resources/prompts even when some plugins are active for other resources/prompts.
*   **Complete Parity**: Ensures global `HTTP` hooks are respected by the Rust runtime.
*   **Clean Architecture**: Python remains the single source of truth for "hook eligibility" without duplicating logic in Rust.
