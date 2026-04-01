# Ticket #3909: Rust MCP Plugin Hook Eligibility Check

**Document Purpose:** Detailed specification of the data Rust MCP runtime sends to Python for hook eligibility checks, based on the existing `tools/call/resolve` pattern. This document defines the request/response contract for implementing equivalent resolve endpoints for `prompts/get` and `resources/read`.

**Date:** 2026-04-01  
**Related Issue:** #3909 - Rust MCP plugin hook semantics inconsistency  
**Status:** Analysis Complete, Implementation Pending

---

## Executive Summary

The Rust MCP runtime currently implements a **two-phase resolve-then-execute pattern** for `tools/call` to check plugin hook eligibility before taking the direct Rust execution path. This same pattern must be extended to `prompts/get` and `resources/read` to fix the bug where active prompt/resource hooks are silently bypassed.

This document captures the **exact request/response contract** between Rust and Python for the resolve endpoint, so implementers can replicate the pattern for prompts and resources.

---

## Part 1: Current `tools/call/resolve` Pattern

### 1.1 Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TOOLS/CALL RESOLVE FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Rust MCP Runtime                                                           │
│     ↓                                                                       │
│  POST /_internal/mcp/tools/call/resolve (to Python)                         │
│     ↓                                                                       │
│  Python: tool_service.prepare_rust_mcp_tool_execution()                     │
│     ├─ Check has_pre_invoke hooks                                           │
│     ├─ Check has_post_invoke hooks                                          │
│     ├─ Run pre_invoke hooks (if any)                                        │
│     └─ Return execution plan                                                │
│     ↓                                                                       │
│  Rust: if eligible → direct DB execution                                    │
│        if !eligible → fallback to Python                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 Rust → Python Request

#### **HTTP Method and URL**

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: 8169-8176

let response = state
    .client
    .post(state.backend_tools_call_resolve_url())
    .headers(build_forwarded_headers(incoming_headers))
    .body(body)
    .send()
    .await
```

**URL Construction:**
```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~700 (AppState::new)

backend_tools_call_resolve_url: Arc<str> = format!(
    "{}/_internal/mcp/tools/call/resolve",
    backend_rpc_url.trim_end_matches('/')
).into()
```

**Default URL:** `http://127.0.0.1:4444/_internal/mcp/tools/call/resolve`

---

#### **Request Body**

**Format:** JSON-RPC 2.0 (original client message, unmodified)

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "my_tool",
    "arguments": {
      "param1": "value1",
      "param2": 123,
      "server_id": "optional-server-id"
    }
  },
  "id": 1
}
```

**Rust Code:**
```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~8060 (handle_tools_call)

let request = match decode_request(&body) {
    Ok(request) => request,
    Err(response) => return response,
};

// ... later in resolve_tools_call_plan_via_backend ...
let response = state
    .client
    .post(state.backend_tools_call_resolve_url())
    .body(body)  // Original Bytes, not parsed
    .send()
    .await
```

**Key Point:** Rust does **NOT** parse or modify the JSON-RPC body before forwarding to Python. Python receives the exact bytes from the client.

---

#### **Request Headers**

**Header Forwarding Logic:**

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: 9770-9797

fn build_forwarded_headers_with_session_validation(
    incoming_headers: &HeaderMap,
    session_validated: bool,
) -> reqwest::header::HeaderMap {
    let mut forwarded_headers = reqwest::header::HeaderMap::new();

    // 1. Forward client headers (except filtered ones)
    for (name, value) in incoming_headers {
        if should_forward_header(name) {
            forwarded_headers.insert(name.clone(), value.clone());
        }
    }

    // 2. Add Rust runtime identifier
    forwarded_headers.insert(
        HeaderName::from_static(RUNTIME_HEADER),  // "x-contextforge-mcp-runtime"
        HeaderValue::from_static(RUNTIME_NAME),   // "rust"
    );

    // 3. Add internal auth header
    forwarded_headers.insert(
        HeaderName::from_static(INTERNAL_RUNTIME_AUTH_HEADER),
        internal_runtime_auth_header_value(),  // "contextforge-internal-mcp-runtime-v1"
    );

    // 4. Add session validation flag (if applicable)
    if session_validated {
        forwarded_headers.insert(
            HeaderName::from_static(SESSION_VALIDATED_HEADER),
            HeaderValue::from_static(RUNTIME_NAME),
        );
    }

    // 5. Inject trace context for observability
    inject_current_trace_context(&mut forwarded_headers);

    forwarded_headers
}
```

---

#### **Headers Forwarded from Client**

**Forwarded Headers (examples):**

| Header Name | Example Value | Purpose |
|-------------|---------------|---------|
| `Authorization` | `Bearer eyJhbGciOiJIUzI1NiIs...` | Client JWT token for authentication |
| `Content-Type` | `application/json` | Request content type |
| `x-contextforge-server-id` | `server-123` | Virtual server scope identifier |
| `x-correlation-id` | `abc-123-def` | Correlation ID for tracing |
| `x-request-id` | `req-456` | Request identifier |
| `mcp-session-id` | `sess-789` | MCP session identifier |
| `x-mcp-session-id` | `sess-789` | Alternative session ID header |
| `x-upstream-authorization` | `Bearer ...` | Authorization for upstream MCP servers |
| `x-trace-id` | `...` | OpenTelemetry trace ID |
| `x-span-id` | `...` | OpenTelemetry span ID |
| `x-langfuse-trace-id` | `...` | Langfuse trace ID |
| `x-langfuse-session-id` | `...` | Langfuse session ID |
| `x-user-email` | `user@example.com` | User email (if set by middleware) |
| `x-token-teams` | `["team1", "team2"]` | Team scope from JWT |
| `x-is-admin` | `true` | Admin flag from JWT |

**Filtered Headers (NOT forwarded):**

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: 9888-9906

fn should_forward_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "keep-alive"
            | "x-real-ip"
            | "x-forwarded-for"
            | "x-forwarded-proto"
            | "x-forwarded-host"
            | "forwarded"
            | "x-forwarded-internally"
            | "x-mcp-session-id"
            | INTERNAL_AFFINITY_FORWARDED_HEADER
            | INTERNAL_RUNTIME_AUTH_HEADER
            | SESSION_VALIDATED_HEADER
            | RUNTIME_HEADER
    )
}
```

**Rationale for filtering:**
- `host`, `content-length`, `connection`, etc. — HTTP hop-by-hop headers, managed by reqwest
- `x-forwarded-*` — Proxy headers, not relevant for internal Rust→Python call
- `x-mcp-session-id` — Stripped to prevent session confusion on internal calls
- `INTERNAL_RUNTIME_AUTH_HEADER`, `SESSION_VALIDATED_HEADER`, `RUNTIME_HEADER` — Added explicitly by Rust, don't forward from client

---

#### **Headers Added by Rust**

| Header Name | Value | Purpose |
|-------------|-------|---------|
| `x-contextforge-mcp-runtime` | `rust` | Identifies request as from Rust runtime |
| `x-contextforge-mcp-runtime-auth` | `contextforge-internal-mcp-runtime-v1` | Internal shared secret for trust |
| `x-correlation-id` | `...` | Trace correlation (from observability context) |
| `x-trace-id` | `...` | OpenTelemetry trace ID |
| `x-span-id` | `...` | Current span ID |
| `x-langfuse-trace-id` | `...` | Langfuse trace ID |
| `x-langfuse-session-id` | `...` | Langfuse session ID |

**Constants:**
```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: 87-95

const RUNTIME_HEADER: &str = "x-contextforge-mcp-runtime";
const RUNTIME_NAME: &str = "rust";
const INTERNAL_RUNTIME_AUTH_HEADER: &str = "x-contextforge-mcp-runtime-auth";
const INTERNAL_RUNTIME_AUTH_CONTEXT: &str = "contextforge-internal-mcp-runtime-v1";
const SESSION_VALIDATED_HEADER: &str = "x-contextforge-session-validated";
```

---

### 1.3 Python Processing

#### **Endpoint Handler**

```python
# File: mcpgateway/main.py
# Line: 9069-9150

@utility_router.post("/_internal/mcp/tools/call/resolve/")
@utility_router.post("/_internal/mcp/tools/call/resolve")
async def handle_internal_mcp_tools_call_resolve(request: Request):
    """Resolve a Rust-direct MCP tools/call execution plan."""
    
    db = SessionLocal()
    try:
        # 1. Build internal user context from headers
        user = _build_internal_mcp_forwarded_user(request)
        
        # 2. Parse JSON-RPC body
        try:
            body = orjson.loads(await request.body())
        except orjson.JSONDecodeError:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None},
            )
        
        # 3. Validate method
        if not isinstance(body, dict) or body.get("method") != "tools/call":
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": body.get("id")},
            )
        
        # 4. Extract params
        params = body.get("params", {})
        if not isinstance(params, dict):
            params = {}
        
        name = params.get("name")
        if not name:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32602, "message": "Missing tool name"}, "id": body.get("id")},
            )
        
        # 5. Extract server_id from headers or params
        server_id = request.headers.get("x-contextforge-server-id") or params.get("server_id")
        if server_id:
            _enforce_internal_mcp_server_scope(request, server_id)
        
        # 6. Check RPC permission
        if (_get_internal_mcp_auth_context(request) or {}).get("is_authenticated", True) is True:
            await _ensure_rpc_permission(user, db, "tools.execute", "tools/call", request=request)
        
        # 7. Extract auth context (user email, teams, admin status)
        auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
        if auth_is_admin and auth_token_teams is None:
            auth_user_email = None  # Admin unrestricted
        elif auth_token_teams is None:
            auth_token_teams = []  # Non-admin without teams = public-only
        
        # 8. Extract arguments for pre_invoke hooks
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        
        # 9. Extract plugin contexts from request.state (set by middleware)
        plugin_context_table = getattr(request.state, "plugin_context_table", None)
        plugin_global_context = getattr(request.state, "plugin_global_context", None)
        
        # 10. Call tool service to check hooks and build plan
        plan = await tool_service.prepare_rust_mcp_tool_execution(
            db=db,
            name=name,
            arguments=arguments,
            request_headers={k.lower(): v for k, v in request.headers.items()},
            app_user_email=get_user_email(user),
            user_email=auth_user_email,
            token_teams=auth_token_teams,
            server_id=server_id,
            plugin_global_context=plugin_global_context,
            plugin_context_table=plugin_context_table,
        )
        
        if db.is_active and db.in_transaction() is not None:
            db.commit()
        return ORJSONResponse(content=plan)
        
    except ToolNotFoundError as exc:
        request_id = body.get("id") if isinstance(body, dict) else None
        return ORJSONResponse(
            status_code=404,
            content={"jsonrpc": "2.0", "error": {"code": -32601, "message": str(exc)}, "id": request_id},
        )
    except ToolInvocationError as exc:
        request_id = body.get("id") if isinstance(body, dict) else None
        return ORJSONResponse(
            status_code=400,
            content={"jsonrpc": "2.0", "error": {"code": -32000, "message": str(exc)}, "id": request_id},
        )
    finally:
        db.close()
```

---

#### **Tool Service Hook Check**

```python
# File: mcpgateway/services/tool_service.py
# Line: 2940-2945, 3200-3202

async def prepare_rust_mcp_tool_execution(
    self,
    db: Session,
    name: str,
    arguments: Dict[str, Any],
    request_headers: Dict[str, str],
    app_user_email: Optional[str],
    user_email: Optional[str],
    token_teams: Optional[List[str]],
    server_id: Optional[str],
    plugin_global_context: Optional[GlobalContext],
    plugin_context_table: Optional[PluginContextTable],
) -> Dict[str, Any]:
    """Prepare Rust MCP tool execution plan with hook checks."""
    
    # 1. Check for active hooks
    has_pre_invoke = self._plugin_manager and self._plugin_manager.has_hooks_for(ToolHookType.TOOL_PRE_INVOKE)
    has_post_invoke = self._plugin_manager and self._plugin_manager.has_hooks_for(ToolHookType.TOOL_POST_INVOKE)
    
    # ... tool lookup, auth checks, etc. ...
    
    # 2. Build hook global context
    hook_global_context = None
    if has_pre_invoke or has_post_invoke:
        hook_global_context = self._build_rust_tool_hook_global_context(
            app_user_email=app_user_email,
            server_id=server_id,
            tool_gateway_id=tool_gateway_id,
            plugin_global_context=plugin_global_context,
            tool_payload=tool_payload,
            gateway_payload=gateway_payload,
        )
    
    # 3. Check post_invoke hooks - forces Python fallback
    native_post_invoke_retry_policy = None
    if has_post_invoke:
        native_post_invoke_retry_policy, requires_python_fallback = self._build_rust_native_tool_post_invoke_retry_policy(
            name, hook_global_context
        )
        if requires_python_fallback:
            return {"eligible": False, "fallbackReason": "post-invoke-hooks-configured"}
    
    # 4. Run pre_invoke hooks (if any)
    modified_args = arguments
    if has_pre_invoke and arguments is not None:
        pre_result, _ = await self._plugin_manager.invoke_hook(
            ToolHookType.TOOL_PRE_INVOKE,
            payload=ToolPreInvokePayload(name=name, args=arguments, headers=HttpHeaderPayload(root=dict(runtime_headers))),
            global_context=hook_global_context,
            local_contexts=plugin_context_table,
            violations_as_exceptions=True,
        )
        if pre_result.modified_payload:
            modified_args = pre_result.modified_payload.args
            if pre_result.modified_payload.name and pre_result.modified_payload.name != name:
                tool_name_original = pre_result.modified_payload.name
            if pre_result.modified_payload.headers is not None:
                plugin_headers = pre_result.modified_payload.headers.root
                for hk, hv in plugin_headers.items():
                    if hk and hv:
                        runtime_headers[str(hk).lower()] = str(hv)
    
    # 5. Build execution plan
    plan: Dict[str, Any] = {
        "eligible": True,
        "transport": transport,
        "serverUrl": gateway_url,
        "remoteToolName": tool_name_original,
        "headers": runtime_headers,
        "timeoutMs": int(effective_timeout * 1000),
        "gatewayId": tool_gateway_id,
        "toolName": name,
        "toolId": tool_id or None,
        "serverId": server_id,
    }
    
    if native_post_invoke_retry_policy is not None:
        plan["postInvokeRetryPolicy"] = native_post_invoke_retry_policy
    if has_pre_invoke:
        plan["hasPreInvokeHooks"] = True
        if modified_args is not None:
            plan["modifiedArgs"] = modified_args
    
    return plan
```

---

### 1.4 Python → Rust Response

#### **Successful Plan (Rust can execute directly)**

```json
{
  "eligible": true,
  "transport": "streamablehttp",
  "serverUrl": "https://upstream-mcp-server.com/mcp",
  "remoteToolName": "actual_tool_name",
  "headers": {
    "Authorization": "Bearer upstream-token",
    "X-Injected-Header": "value-from-pre-invoke-hook"
  },
  "timeoutMs": 60000,
  "gatewayId": "gateway-123",
  "toolName": "my_tool",
  "toolId": "tool-456",
  "serverId": "server-789",
  "hasPreInvokeHooks": true,
  "modifiedArgs": {
    "param1": "normalized-by-hook",
    "param2": 123
  }
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `eligible` | `boolean` | Yes | `true` if Rust can execute directly, `false` if must fallback to Python |
| `transport` | `string` | Yes (if eligible) | Must be `"streamablehttp"` for Rust direct execution |
| `serverUrl` | `string` | Yes (if eligible) | Upstream MCP server URL with auth applied |
| `remoteToolName` | `string` | Yes (if eligible) | Tool name at upstream server (may differ from local name) |
| `headers` | `object` | Yes (if eligible) | Auth headers including any injected by pre_invoke hooks |
| `timeoutMs` | `number` | Yes (if eligible) | Timeout in milliseconds |
| `gatewayId` | `string` | Yes | Gateway identifier |
| `toolName` | `string` | Yes | Local tool name |
| `toolId` | `string` | Yes | Tool database ID |
| `serverId` | `string` | Optional | Virtual server scope |
| `hasPreInvokeHooks` | `boolean` | Yes | `true` if pre_invoke hooks ran (disables plan caching) |
| `modifiedArgs` | `object` | Yes (if hooks ran) | Arguments transformed by pre_invoke hooks |
| `postInvokeRetryPolicy` | `object` | Optional | Native Rust retry policy for post_invoke (RetryWithBackoffPlugin only) |
| `fallbackReason` | `string` | Yes (if !eligible) | Reason for fallback (see below) |

---

#### **Fallback Plan (Python must execute)**

```json
{
  "eligible": false,
  "fallbackReason": "post-invoke-hooks-configured"
}
```

**Possible `fallbackReason` Values:**

| Reason | Meaning |
|--------|---------|
| `post-invoke-hooks-configured` | Active `tool_post_invoke` hooks require Python execution |
| `observability-trace-active` | Active observability trace requires Python path |
| `direct-proxy` | Gateway is in `direct_proxy` mode |
| `unsupported-integration:XXX` | Tool integration type is not MCP |
| `unsupported-transport:XXX` | Transport is not `streamablehttp` (e.g., `sse`, `stdio`) |
| `jsonpath-filter-configured` | Tool has JSONPath filter configured |
| `custom-ca-certificate` | Gateway has custom CA certificate |
| `missing-gateway-url` | Gateway URL is missing |
| `direct-proxy` | Gateway mode is `direct_proxy` |

---

#### **Error Responses**

**Tool Not Found (404):**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32601,
    "message": "Tool not found: my_tool"
  },
  "id": 1
}
```

**Tool Invocation Error (400):**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Tool 'my_tool' exists but is inactive"
  },
  "id": 1
}
```

**Parse Error (400):**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32700,
    "message": "Parse error"
  },
  "id": null
}
```

**Invalid Request (400):**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32600,
    "message": "Invalid Request"
  },
  "id": 1
}
```

---

## Part 2: Pattern for `prompts/get/resolve` and `resources/read/resolve`

### 2.1 Required Python Endpoints

**New endpoints to add:**

| Endpoint | Method | Handler Function |
|----------|--------|------------------|
| `/_internal/mcp/prompts/get/resolve` | POST | `handle_internal_mcp_prompts_get_resolve()` |
| `/_internal/mcp/resources/read/resolve` | POST | `handle_internal_mcp_resources_read_resolve()` |

---

### 2.2 Request Contract (Same as tools/call/resolve)

**Rust sends:**

```rust
// Pseudocode for prompts/get resolve

let response = state
    .client
    .post(state.backend_prompts_get_resolve_url())  // NEW URL
    .headers(build_forwarded_headers(incoming_headers))  // Same header logic
    .body(body)  // Original JSON-RPC: {"method": "prompts/get", "params": {...}}
    .send()
    .await
```

**Request Body:**
```json
{
  "jsonrpc": "2.0",
  "method": "prompts/get",
  "params": {
    "name": "my_prompt",
    "arguments": {
      "key": "value"
    }
  },
  "id": 1
}
```

**Headers:** Identical to `tools/call/resolve` (see Section 1.3)

---

### 2.3 Python Handler Template

```python
@utility_router.post("/_internal/mcp/prompts/get/resolve/")
@utility_router.post("/_internal/mcp/prompts/get/resolve")
async def handle_internal_mcp_prompts_get_resolve(request: Request):
    """Resolve a Rust-direct MCP prompts/get execution plan."""
    
    db = SessionLocal()
    try:
        user = _build_internal_mcp_forwarded_user(request)
        
        # Parse body
        try:
            body = orjson.loads(await request.body())
        except orjson.JSONDecodeError:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None},
            )
        
        # Validate method
        if not isinstance(body, dict) or body.get("method") != "prompts/get":
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": body.get("id")},
            )
        
        # Extract params
        params = body.get("params", {})
        if not isinstance(params, dict):
            params = {}
        
        name = params.get("name")
        if not name:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32602, "message": "Missing prompt name"}, "id": body.get("id")},
            )
        
        # Extract server_id
        server_id = request.headers.get("x-contextforge-server-id") or params.get("server_id")
        if server_id:
            _enforce_internal_mcp_server_scope(request, server_id)
        
        # Check permission
        if (_get_internal_mcp_auth_context(request) or {}).get("is_authenticated", True) is True:
            await _ensure_rpc_permission(user, db, "prompts.read", "prompts/get", request=request)
        
        # Extract auth context
        auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
        if auth_is_admin and auth_token_teams is None:
            auth_user_email = None
        elif auth_token_teams is None:
            auth_token_teams = []
        
        # Extract arguments
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        
        # Extract plugin contexts
        plugin_context_table = getattr(request.state, "plugin_context_table", None)
        plugin_global_context = getattr(request.state, "plugin_global_context", None)
        
        # Check for active prompt hooks
        has_pre_fetch = prompt_service._plugin_manager and prompt_service._plugin_manager.has_hooks_for(PromptHookType.PROMPT_PRE_FETCH)
        has_post_fetch = prompt_service._plugin_manager and prompt_service._plugin_manager.has_hooks_for(PromptHookType.PROMPT_POST_FETCH)
        
        # Build execution plan
        plan = {
            "eligible": not (has_pre_fetch or has_post_fetch),
            "promptName": name,
            "serverId": server_id,
        }
        
        if has_pre_fetch or has_post_fetch:
            plan["fallbackReason"] = "prompt-hooks-configured"
            plan["hasPreFetchHooks"] = has_pre_fetch
            plan["hasPostFetchHooks"] = has_post_fetch
            
            # Build hook context for potential fallback
            hook_global_context = prompt_service._build_rust_prompt_hook_global_context(
                app_user_email=auth_user_email,
                server_id=server_id,
                plugin_global_context=plugin_global_context,
            )
            plan["hookGlobalContext"] = hook_global_context.model_dump() if hasattr(hook_global_context, "model_dump") else {}
        
        if db.is_active and db.in_transaction() is not None:
            db.commit()
        return ORJSONResponse(content=plan)
        
    except PromptNotFoundError as exc:
        request_id = body.get("id") if isinstance(body, dict) else None
        return ORJSONResponse(
            status_code=404,
            content={"jsonrpc": "2.0", "error": {"code": -32601, "message": str(exc)}, "id": request_id},
        )
    except PromptError as exc:
        request_id = body.get("id") if isinstance(body, dict) else None
        return ORJSONResponse(
            status_code=400,
            content={"jsonrpc": "2.0", "error": {"code": -32000, "message": str(exc)}, "id": request_id},
        )
    finally:
        db.close()
```

---

### 2.4 Response Contract

**Successful Plan (Rust can execute directly - NO hooks active):**
```json
{
  "eligible": true,
  "promptName": "my_prompt",
  "serverId": "server-123"
}
```

**Fallback Plan (hooks active):**
```json
{
  "eligible": false,
  "fallbackReason": "prompt-hooks-configured",
  "hasPreFetchHooks": true,
  "hasPostFetchHooks": true,
  "hookGlobalContext": {
    "request_id": "abc-123",
    "server_id": "server-123",
    "user": "user@example.com"
  }
}
```

---

### 2.5 Required Python Service Helpers

**Add to `PromptService`:**

```python
# File: mcpgateway/services/prompt_service.py

def _build_rust_prompt_hook_global_context(
    self,
    *,
    app_user_email: Optional[str],
    server_id: Optional[str],
    plugin_global_context: Optional[GlobalContext],
) -> GlobalContext:
    """Build plugin global context for Rust-direct prompt plan resolution."""
    from mcpgateway.utils.correlation_id import get_correlation_id
    
    if plugin_global_context:
        hook_global_context = plugin_global_context
        if not hook_global_context.user and app_user_email:
            hook_global_context.user = app_user_email
        if server_id:
            hook_global_context.server_id = server_id
    else:
        request_id = get_correlation_id() or uuid.uuid4().hex
        hook_global_context = GlobalContext(
            request_id=request_id,
            server_id=server_id,
            tenant_id=None,
            user=app_user_email,
        )
    
    return hook_global_context
```

**Add to `ResourceService`:**

```python
# File: mcpgateway/services/resource_service.py

def _build_rust_resource_hook_global_context(
    self,
    *,
    app_user_email: Optional[str],
    server_id: Optional[str],
    resource_uri: str,
    plugin_global_context: Optional[GlobalContext],
) -> GlobalContext:
    """Build plugin global context for Rust-direct resource plan resolution."""
    from mcpgateway.utils.correlation_id import get_correlation_id
    
    if plugin_global_context:
        hook_global_context = plugin_global_context
        if not hook_global_context.user and app_user_email:
            hook_global_context.user = app_user_email
        if server_id:
            hook_global_context.server_id = server_id
    else:
        request_id = get_correlation_id() or uuid.uuid4().hex
        hook_global_context = GlobalContext(
            request_id=request_id,
            server_id=server_id,
            tenant_id=None,
            user=app_user_email,
        )
    
    return hook_global_context
```

---

## Part 3: Rust Runtime Changes Required

### 3.1 Add Backend URLs to AppState

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~125-175 (AppState struct)

pub struct AppState {
    // ... existing fields ...
    
    // NEW: Resolve endpoint URLs
    backend_prompts_get_resolve_url: Arc<str>,
    backend_resources_read_resolve_url: Arc<str>,
}
```

**Initialize in `AppState::new()`:**

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~676-850 (AppState::new implementation)

impl AppState {
    pub fn new(config: &RuntimeConfig) -> Result<Self, RuntimeError> {
        // ... existing initialization ...
        
        let backend_prompts_get_resolve_url = format!(
            "{}/_internal/mcp/prompts/get/resolve",
            config.backend_rpc_url.trim_end_matches('/')
        ).into();
        
        let backend_resources_read_resolve_url = format!(
            "{}/_internal/mcp/resources/read/resolve",
            config.backend_rpc_url.trim_end_matches('/')
        ).into();
        
        Ok(Self {
            // ... existing fields ...
            backend_prompts_get_resolve_url,
            backend_resources_read_resolve_url,
        })
    }
}
```

---

### 3.2 Add Resolve Plan Structs

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~500-600 (near ResolvedMcpToolCallPlan)

#[derive(Debug, Clone, Deserialize)]
struct ResolvedPromptGetPlan {
    eligible: bool,
    #[serde(rename = "promptName")]
    prompt_name: String,
    #[serde(rename = "serverId")]
    server_id: Option<String>,
    #[serde(rename = "fallbackReason")]
    fallback_reason: Option<String>,
    #[serde(rename = "hasPreFetchHooks")]
    has_pre_fetch_hooks: Option<bool>,
    #[serde(rename = "hasPostFetchHooks")]
    has_post_fetch_hooks: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct ResolvedResourceReadPlan {
    eligible: bool,
    #[serde(rename = "resourceUri")]
    resource_uri: String,
    #[serde(rename = "serverId")]
    server_id: Option<String>,
    #[serde(rename = "fallbackReason")]
    fallback_reason: Option<String>,
    #[serde(rename = "hasPreFetchHooks")]
    has_pre_fetch_hooks: Option<bool>,
    #[serde(rename = "hasPostFetchHooks")]
    has_post_fetch_hooks: Option<bool>,
}
```

---

### 3.3 Add Resolve Functions

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~8164 (after resolve_tools_call_plan_via_backend)

async fn resolve_prompts_get_plan_via_backend(
    state: &AppState,
    incoming_headers: &HeaderMap,
    body: Bytes,
) -> Result<ResolvedPromptGetPlan, ResolveToolsCallError> {
    let response = state
        .client
        .post(state.backend_prompts_get_resolve_url())
        .headers(build_forwarded_headers(incoming_headers))
        .body(body)
        .send()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("prompts/get resolve request failed: {err}")))?;
    
    let status = response.status();
    let headers = response.headers().clone();
    let response_body = response
        .bytes()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("prompts/get resolve read failed: {err}")))?;
    
    if !status.is_success() {
        if let Ok(payload) = serde_json::from_slice::<Value>(&response_body)
            && payload.get("jsonrpc") == Some(&Value::String(JSONRPC_VERSION.to_string()))
            && payload.get("error").is_some()
        {
            return Err(ResolveToolsCallError::JsonRpcError { payload, headers });
        }
        return Err(ResolveToolsCallError::Fallback(format!(
            "prompts/get resolve returned status {status}"
        )));
    }
    
    let plan = serde_json::from_slice::<ResolvedPromptGetPlan>(&response_body).map_err(|err| {
        if let Ok(payload) = serde_json::from_slice::<Value>(&response_body)
            && payload.get("jsonrpc") == Some(&Value::String(JSONRPC_VERSION.to_string()))
            && payload.get("error").is_some()
        {
            return ResolveToolsCallError::JsonRpcError { payload, headers };
        }
        ResolveToolsCallError::Fallback(format!("prompts/get resolve decode failed: {err}"))
    })?;
    
    Ok(plan)
}

async fn resolve_resources_read_plan_via_backend(
    state: &AppState,
    incoming_headers: &HeaderMap,
    body: Bytes,
) -> Result<ResolvedResourceReadPlan, ResolveToolsCallError> {
    let response = state
        .client
        .post(state.backend_resources_read_resolve_url())
        .headers(build_forwarded_headers(incoming_headers))
        .body(body)
        .send()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resources/read resolve request failed: {err}")))?;
    
    let status = response.status();
    let headers = response.headers().clone();
    let response_body = response
        .bytes()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resources/read resolve read failed: {err}")))?;
    
    if !status.is_success() {
        if let Ok(payload) = serde_json::from_slice::<Value>(&response_body)
            && payload.get("jsonrpc") == Some(&Value::String(JSONRPC_VERSION.to_string()))
            && payload.get("error").is_some()
        {
            return Err(ResolveToolsCallError::JsonRpcError { payload, headers });
        }
        return Err(ResolveToolsCallError::Fallback(format!(
            "resources/read resolve returned status {status}"
        )));
    }
    
    let plan = serde_json::from_slice::<ResolvedResourceReadPlan>(&response_body).map_err(|err| {
        if let Ok(payload) = serde_json::from_slice::<Value>(&response_body)
            && payload.get("jsonrpc") == Some(&Value::String(JSONRPC_VERSION.to_string()))
            && payload.get("error").is_some()
        {
            return ResolveToolsCallError::JsonRpcError { payload, headers };
        }
        ResolveToolsCallError::Fallback(format!("resources/read resolve decode failed: {err}"))
    })?;
    
    Ok(plan)
}
```

---

### 3.4 Update Handlers

**Update `handle_prompts_get()`:**

```rust
// File: tools_rust/mcp_runtime/src/lib.rs
// Line: ~5280-5460

async fn handle_prompts_get(
    state: &AppState,
    incoming_headers: HeaderMap,
    body: Bytes,
    request_id: Option<Value>,
) -> Response {
    // ... existing authz checks ...
    
    // NEW: Call resolve endpoint BEFORE direct DB query
    let resolve_plan = match resolve_prompts_get_plan_via_backend(state, &incoming_headers, body.clone()).await {
        Ok(plan) => plan,
        Err(ResolveToolsCallError::Fallback(err)) => {
            warn!("Rust MCP direct prompts/get resolve fallback: {err}");
            return forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await;
        }
        Err(ResolveToolsCallError::JsonRpcError { payload, headers: _ }) => {
            // Return JSON-RPC error directly
            return json_response(StatusCode::OK, payload);
        }
    };
    
    // Check if eligible for direct DB execution
    if !resolve_plan.eligible {
        if let Some(reason) = resolve_plan.fallback_reason.as_deref() {
            info!("Rust MCP direct prompts/get falling back to Python: {reason}");
        }
        return forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await;
    }
    
    // Eligible - proceed with direct DB query
    match query_server_prompt_get_from_db(state, &server_id, &auth_context, &prompt_name).await {
        Ok(Some(payload)) => {
            // ... existing success handling ...
        }
        // ... existing error handling ...
    }
}
```

**Update `handle_resources_read()` similarly.**

---

## Part 4: Test Scenarios

### 4.1 Test: prompt_post_fetch Forces Fallback

**Configuration:**
```yaml
# plugins/plugin_parity_config.yaml
plugins:
  - name: "PromptOutputSentinelPlugin"
    hooks: ["prompt_post_fetch"]
    mode: "enforce"
    conditions:
      - prompts: ["fast-time-convert-time-detailed"]
    config:
      sentinel_text: "[PROMPT-POST-FETCH-SENTINEL]"
```

**Expected Flow:**
1. Client sends `prompts/get` request
2. Rust calls `POST /_internal/mcp/prompts/get/resolve`
3. Python returns `{"eligible": false, "fallbackReason": "prompt-hooks-configured"}`
4. Rust forwards to Python `POST /_internal/mcp/prompts/get`
5. Python executes `prompt_post_fetch` hooks
6. Response includes `[PROMPT-POST-FETCH-SENTINEL]`

**Log Output:**
```
INFO Rust MCP direct prompts/get falling back to Python: prompt-hooks-configured
```

---

### 4.2 Test: resource_post_fetch Forces Fallback

**Configuration:**
```yaml
# plugins/plugin_parity_config.yaml
plugins:
  - name: "LicenseHeaderInjector"
    hooks: ["resource_post_fetch"]
    mode: "enforce"
    conditions:
      - resources: ["time://formats"]
    config:
      header_template: "SPDX-License-Identifier: Apache-2.0"
```

**Expected Flow:**
1. Client sends `resources/read` request
2. Rust calls `POST /_internal/mcp/resources/read/resolve`
3. Python returns `{"eligible": false, "fallbackReason": "resource-hooks-configured"}`
4. Rust forwards to Python
5. Python executes `resource_post_fetch` hooks
6. Response includes SPDX header

**Log Output:**
```
INFO Rust MCP direct resources/read falling back to Python: resource-hooks-configured
```

---

### 4.3 Test: No Hooks - Direct Rust Execution

**Configuration:** No active prompt/resource hooks

**Expected Flow:**
1. Client sends `prompts/get` request
2. Rust calls `POST /_internal/mcp/prompts/get/resolve`
3. Python returns `{"eligible": true, "promptName": "..."}`
4. Rust executes direct DB query
5. Response returned without Python involvement

**Log Output:** (no fallback log)

---

## Part 5: Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `mcpgateway/services/prompt_service.py` | Add `_build_rust_prompt_hook_global_context()` | ~3064 |
| `mcpgateway/services/resource_service.py` | Add `_build_rust_resource_hook_global_context()` | ~3850 |
| `mcpgateway/main.py` | Add `handle_internal_mcp_prompts_get_resolve()` | ~9210 |
| `mcpgateway/main.py` | Add `handle_internal_mcp_resources_read_resolve()` | ~9280 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `backend_prompts_get_resolve_url` to `AppState` | ~125-175 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `backend_resources_read_resolve_url` to `AppState` | ~125-175 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `ResolvedPromptGetPlan` struct | ~500-600 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `ResolvedResourceReadPlan` struct | ~500-600 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `resolve_prompts_get_plan_via_backend()` | ~8164 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `resolve_resources_read_plan_via_backend()` | ~8164 |
| `tools_rust/mcp_runtime/src/lib.rs` | Update `handle_prompts_get()` | ~5280 |
| `tools_rust/mcp_runtime/src/lib.rs` | Update `handle_resources_read()` | ~5160 |

---

## Part 6: Key Design Principles

1. **Mirror existing pattern**: Replicate `tools/call/resolve` architecture exactly
2. **Same request format**: JSON-RPC body + forwarded headers
3. **Same response format**: `eligible` boolean + `fallbackReason` string
4. **Fail-closed**: When hooks active, always fallback to Python
5. **Preserve plugin semantics**: Hooks must execute or force fallback, never bypass
6. **Minimal Rust changes**: Only add resolve calls and plan structs
7. **Cache plans later**: Can add caching after initial implementation (like tools has)

---

## Appendix A: Header Forwarding Reference

**Forwarded from Client:**
- `Authorization`
- `Content-Type`
- `x-contextforge-server-id`
- `x-correlation-id`
- `x-request-id`
- `mcp-session-id`
- `x-upstream-authorization`
- All observability headers (`x-trace-id`, `x-span-id`, `x-langfuse-*`)
- All custom passthrough headers

**NOT Forwarded:**
- `host`, `content-length`, `connection`, `transfer-encoding`, `keep-alive`
- `x-real-ip`, `x-forwarded-*` (proxy headers)
- `x-mcp-session-id` (stripped for internal calls)
- `x-contextforge-mcp-runtime-auth` (added by Rust)
- `x-contextforge-session-validated` (added by Rust)
- `x-contextforge-mcp-runtime` (added by Rust)

**Added by Rust:**
- `x-contextforge-mcp-runtime: rust`
- `x-contextforge-mcp-runtime-auth: contextforge-internal-mcp-runtime-v1`
- `x-contextforge-session-validated: rust` (if session validated)
- Observability headers (from current trace context)

---

## Appendix B: Error Code Reference

| Code | Meaning | When Used |
|------|---------|-----------|
| -32700 | Parse error | Invalid JSON body |
| -32600 | Invalid Request | Wrong method or structure |
| -32601 | Method not found | Tool/prompt/resource not found |
| -32602 | Invalid params | Missing required parameter |
| -32000 | Server error | Tool/prompt/resource error |
| -32003 | Permission denied | RBAC check failed |

---

**End of Document**
