# Ticket #3909: Rust MCP Request Decoding and Routing

**Document Purpose:** Detailed analysis of how the Rust MCP runtime decodes, parses, and routes JSON-RPC requests. Clarifies what Rust extracts from the request body vs. what it forwards opaque to Python.

**Date:** 2026-04-01  
**Related Issue:** #3909 - Rust MCP plugin hook semantics inconsistency  
**Status:** Analysis Complete

---

## Executive Summary

The Rust MCP runtime implements a **two-tier parsing strategy**:

1. **Rust parses the JSON-RPC envelope** (`method`, `id`, `jsonrpc` version) for **routing and validation**
2. **Rust forwards `params` as opaque `Value`** to Python without inspecting internal structure
3. **Python parses `params` content** (`name`, `arguments`, `uri`) for **hook execution**

This separation ensures:
- **Fast routing** in Rust (method-based dispatch)
- **Correct hook execution** in Python (plugins can modify params)
- **No duplication** of parsing logic

---

## Part 1: Request Flow Overview

### 1.1 Complete Request Journey

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Request                               │
│                                                                 │
│  POST /mcp                                                      │
│  Content-Type: application/json                                 │
│                                                                 │
│  Body:                                                          │
│  {                                                              │
│    "jsonrpc": "2.0",                                            │
│    "method": "tools/call",                                      │
│    "params": {                                                  │
│      "name": "my_tool",                                         │
│      "arguments": {"param1": "value1", "param2": 123}          │
│    },                                                           │
│    "id": 1                                                      │
│  }                                                              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ HTTP POST
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Rust MCP Runtime (Port 8080)                       │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 1. decode_request(&body)                                  │ │
│  │    File: tools_rust/mcp_runtime/src/lib.rs:2590          │ │
│  │                                                           │ │
│  │    Parses JSON envelope:                                  │ │
│  │    ✓ method = "tools/call"                                │ │
│  │    ✓ id = 1                                               │ │
│  │    ✓ jsonrpc = "2.0"                                      │ │
│  │    ✓ params = {"name":..., "arguments":...} as Value     │ │
│  │                                                           │ │
│  │    Does NOT parse params internals:                       │ │
│  │    ✗ params.name (opaque)                                 │ │
│  │    ✗ params.arguments (opaque)                            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 2. Route by method                                        │ │
│  │    File: tools_rust/mcp_runtime/src/lib.rs:1615-1650     │ │
│  │                                                           │ │
│  │    match request.method {                                 │ │
│  │        "tools/call" => handle_tools_call(...),            │ │
│  │        "prompts/get" => handle_prompts_get(...),          │ │
│  │        "resources/read" => handle_resources_read(...),    │ │
│  │        _ => forward_to_python(...),                       │ │
│  │    }                                                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 3. Forward to Python for resolve                          │ │
│  │    File: tools_rust/mcp_runtime/src/lib.rs:8169-8176     │ │
│  │                                                           │ │
│  │    POST http://127.0.0.1:4444/_internal/mcp/tools/call/resolve │ │
│  │    Headers: [Authorization, x-contextforge-server-id, ...]│ │
│  │    Body: body  ← Original Bytes (NOT re-serialized!)     │ │
│  │                                                           │ │
│  │    Rust does NOT extract or modify params content        │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ HTTP POST (loopback)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Python Gateway (Port 4444)                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 1. Parse full body                                        │ │
│  │    File: mcpgateway/main.py:9089-9095                    │ │
│  │                                                           │ │
│  │    body = orjson.loads(await request.body())             │ │
│  │    method = body["method"]         # "tools/call"        │ │
│  │    params = body["params"]         # {...}               │ │
│  │    name = params["name"]           # "my_tool"           │ │
│  │    arguments = params["arguments"] # {"param1":...}      │ │
│  │                                                           │ │
│  │    Python extracts ALL fields for hook execution         │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 2. Check and execute hooks                                │ │
│  │    File: mcpgateway/services/tool_service.py:2940-3240   │ │
│  │                                                           │ │
│  │    has_pre_invoke = plugin_manager.has_hooks_for(...)    │ │
│  │    if has_pre_invoke:                                     │ │
│  │        pre_result = await plugin_manager.invoke_hook(     │ │
│  │            ToolHookType.TOOL_PRE_INVOKE,                  │ │
│  │            payload=ToolPreInvokePayload(                  │ │
│  │                name=name,          # ← Extracted          │ │
│  │                args=arguments,     # ← Extracted          │ │
│  │            ),                                             │ │
│  │        )                                                  │ │
│  │        modified_args = pre_result.modified_payload.args   │ │
│  │    }                                                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 3. Return execution plan                                  │ │
│  │    File: mcpgateway/main.py:9141-9148                    │ │
│  │                                                           │ │
│  │    return ORJSONResponse(content={                       │ │
│  │        "eligible": True,                                  │ │
│  │        "modifiedArgs": modified_args,  # From hooks       │ │
│  │        "headers": {...},                 # From hooks     │ │
│  │    })                                                     │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ HTTP Response
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Rust MCP Runtime                                   │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 4. Apply hook results and execute                         │ │
│  │    File: tools_rust/mcp_runtime/src/lib.rs:8220-8240     │ │
│  │                                                           │ │
│  │    if plan.eligible:                                      │ │
│  │        # Apply modified args from pre_invoke hooks       │ │
│  │        if let Some(args) = plan.modified_args {          │ │
│  │            // Use modified arguments for upstream call   │ │
│  │        }                                                  │ │
│  │        // Apply injected headers from hooks              │ │
│  │        // Call upstream MCP server directly              │ │
│  │    else:                                                  │ │
│  │        # Fallback to Python                               │ │
│  │        forward_tools_call_to_backend(...)                 │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Rust Request Decoding

### 2.1 decode_request() Function

**Location:** `tools_rust/mcp_runtime/src/lib.rs:2590-2619`

```rust
#[allow(clippy::result_large_err)]
fn decode_request(body: &[u8]) -> Result<JsonRpcRequest, Response> {
    // 1. Parse JSON from bytes
    let parsed: Value = serde_json::from_slice(body).map_err(|_| parse_error_response())?;
    
    // 2. Reject batch requests (arrays)
    if parsed.is_array() {
        return Err(batch_rejected_response());
    }
    
    // 3. Extract as object
    let object = parsed
        .as_object()
        .ok_or_else(|| invalid_request_response(&Value::Null))?;
    
    // 4. Get request ID for error responses
    let request_id = object.get("id").cloned().unwrap_or(Value::Null);
    
    // 5. Validate JSON-RPC version
    if let Some(version) = object.get("jsonrpc").and_then(Value::as_str)
        && version != JSONRPC_VERSION
    {
        return Err(invalid_request_response(&request_id));
    }
    
    // 6. ✅ EXTRACT METHOD for routing (CRITICAL STEP)
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_request_response(&request_id))?;
    
    // 7. Build JsonRpcRequest struct
    Ok(JsonRpcRequest {
        jsonrpc: Some(JSONRPC_VERSION.to_string()),
        method: method.to_string(),  // ← Parsed and stored
        params: object.get("params").cloned().unwrap_or_else(|| json!({})),  // ← Cloned as opaque Value
        id: object.get("id").cloned(),
    })
}
```

**What Rust Extracts:**

| Field | Type | Purpose | Used By |
|-------|------|---------|---------|
| `method` | `String` | Routing decision | `handle_*()` dispatch |
| `id` | `Value` | Response correlation | JSON-RPC response |
| `jsonrpc` | `String` | Version validation | Protocol compliance |
| `params` | `Value` | Opaque payload | Forwarded to Python |

**What Rust Does NOT Extract:**

| Field | Example | Why Not Extracted |
|-------|---------|-------------------|
| `params.name` | `"my_tool"` | Python needs this for hook payloads |
| `params.arguments` | `{"x": 1}` | Plugins may modify; Python runs hooks |
| `params.uri` | `"time://now"` | Python needs for resource hook execution |
| `params.cursor` | `"abc123"` | Method-specific; Python handles |

---

### 2.2 JsonRpcRequest Struct

**Location:** `tools_rust/mcp_runtime/src/lib.rs:196-206`

```rust
#[derive(Debug, Clone, Deserialize)]
/// Minimal JSON-RPC request envelope accepted by the runtime edge.
pub struct JsonRpcRequest {
    pub jsonrpc: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub id: Option<Value>,
}

impl JsonRpcRequest {
    /// Returns `true` if this request is a notification (no `id` field).
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}
```

**Key Design:**
- `params` is `Value` (serde_json::Value) - **opaque JSON**
- No typed fields for `name`, `arguments`, `uri`, etc.
- Rust treats params as a black box

---

### 2.3 Method-Based Routing

**Location:** `tools_rust/mcp_runtime/src/lib.rs:1615-1650`

```rust
// Decode request and extract method
let request = match decode_request(&body) {
    Ok(request) => request,
    Err(response) => return response,
};

// Server scope check (from headers)
let server_scoped_request = has_server_scope(&headers);

// Method-based routing flags
let server_scoped_tools_list = request.method == "tools/list" && server_scoped_request;
let rust_db_direct_tools_list = server_scoped_tools_list && state.db_pool().is_some();

let specialized_initialize = request.method == "initialize";
let specialized_resources_list = request.method == "resources/list";
let specialized_resources_read = request.method == "resources/read";
let specialized_resources_subscribe = request.method == "resources/subscribe";
let specialized_resources_unsubscribe = request.method == "resources/unsubscribe";
let specialized_resource_templates_list = request.method == "resources/templates/list";
let specialized_prompts_list = request.method == "prompts/list";
let specialized_prompts_get = request.method == "prompts/get";
let specialized_roots_list = request.method == "roots/list";
let specialized_completion_complete = request.method == "completion/complete";
let specialized_sampling_create_message = request.method == "sampling/createMessage";
let specialized_logging_set_level = request.method == "logging/setLevel";

// Notification detection
let specialized_initialized_notification =
    request.is_notification() && request.method == "notifications/initialized";
let specialized_message_notification =
    request.is_notification() && request.method == "notifications/message";
let specialized_cancelled_notification =
    request.is_notification() && request.method == "notifications/cancelled";

// Catch-all patterns
let catch_all_notifications = request.method.starts_with("notifications/")
    && !specialized_initialized_notification
    && !specialized_message_notification
    && !specialized_cancelled_notification;

// ✅ Method flags used for routing decisions
let specialized_tools_call = request.method == "tools/call";
let rust_db_direct_resources_read = specialized_resources_read
    && server_scoped_request
    && state.db_pool().is_some()
    && can_use_direct_resources_read(&request.params);  // ← Only check, not parse
let rust_db_direct_prompts_get = specialized_prompts_get
    && server_scoped_request
    && state.db_pool().is_some()
    && can_use_direct_prompts_get(&request.params);  // ← Only check, not parse
```

**Key Observation:**
- Rust checks `request.method == "..."` for **all routing decisions**
- `request.params` is passed to helper functions (e.g., `can_use_direct_prompts_get`) but **not parsed**
- Helper functions may inspect params structure, but Rust core doesn't

---

### 2.4 Body Forwarding to Python

**Location:** `tools_rust/mcp_runtime/src/lib.rs:8169-8176`

```rust
async fn resolve_tools_call_plan_via_backend(
    state: &AppState,
    incoming_headers: &HeaderMap,
    body: Bytes,  // ← Original bytes from client
) -> Result<ResolvedMcpToolCallPlan, ResolveToolsCallError> {
    let response = state
        .client
        .post(state.backend_tools_call_resolve_url())
        .headers(build_forwarded_headers(incoming_headers))
        .body(body)  // ← Forwarded as-is, NOT re-serialized!
        .send()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resolve request failed: {err}")))?;
    
    // ... response handling ...
}
```

**Key Point:**
- `body: Bytes` is the **original HTTP request body** from the client
- Rust does **NOT** serialize `JsonRpcRequest` back to JSON
- Python receives the **exact same bytes** the client sent

---

## Part 3: Python Request Parsing

### 3.1 Python Endpoint Handler

**Location:** `mcpgateway/main.py:9089-9120`

```python
@utility_router.post("/_internal/mcp/tools/call/resolve/")
@utility_router.post("/_internal/mcp/tools/call/resolve")
async def handle_internal_mcp_tools_call_resolve(request: Request):
    """Resolve a Rust-direct MCP tools/call execution plan."""
    
    db = SessionLocal()
    try:
        user = _build_internal_mcp_forwarded_user(request)
        
        # 1. ✅ Parse full JSON body (including params)
        try:
            body = orjson.loads(await request.body())
        except orjson.JSONDecodeError:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None},
            )
        
        # 2. Validate method
        if not isinstance(body, dict) or body.get("method") != "tools/call":
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": body.get("id")},
            )
        
        # 3. ✅ Extract params content
        params = body.get("params", {})
        if not isinstance(params, dict):
            params = {}
        
        # 4. ✅ Extract method-specific fields
        name = params.get("name")  # ← Python extracts!
        if not name:
            return ORJSONResponse(
                status_code=400,
                content={"jsonrpc": "2.0", "error": {"code": -32602, "message": "Missing tool name"}, "id": body.get("id")},
            )
        
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}  # ← Python extracts!
        
        # 5. Extract other context
        server_id = request.headers.get("x-contextforge-server-id") or params.get("server_id")
        auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
        plugin_context_table = getattr(request.state, "plugin_context_table", None)
        plugin_global_context = getattr(request.state, "plugin_global_context", None)
        
        # 6. Call tool service with extracted params
        plan = await tool_service.prepare_rust_mcp_tool_execution(
            db=db,
            name=name,              # ← Extracted by Python
            arguments=arguments,    # ← Extracted by Python
            request_headers={k.lower(): v for k, v in request.headers.items()},
            app_user_email=get_user_email(user),
            user_email=auth_user_email,
            token_teams=auth_token_teams,
            server_id=server_id,
            plugin_global_context=plugin_global_context,
            plugin_context_table=plugin_context_table,
        )
        
        return ORJSONResponse(content=plan)
    finally:
        db.close()
```

**What Python Extracts:**

| Field | Source | Purpose |
|-------|--------|---------|
| `method` | `body["method"]` | Validation |
| `name` | `params["name"]` | Tool/prompt/resource lookup |
| `arguments` | `params["arguments"]` | Pre-invoke hook payload |
| `uri` | `params["uri"]` | Resource lookup |
| `server_id` | `params["server_id"]` or headers | Scope validation |
| `cursor` | `params["cursor"]` | Pagination |

---

### 3.2 Hook Execution with Extracted Params

**Location:** `mcpgateway/services/tool_service.py:3200-3220`

```python
async def prepare_rust_mcp_tool_execution(
    self,
    db: Session,
    name: str,              # ← Extracted by Python
    arguments: Dict[str, Any],  # ← Extracted by Python
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
    
    # 2. ✅ Run pre_invoke hooks with extracted params
    modified_args = arguments
    if has_pre_invoke and arguments is not None:
        pre_result, _ = await self._plugin_manager.invoke_hook(
            ToolHookType.TOOL_PRE_INVOKE,
            payload=ToolPreInvokePayload(
                name=name,          # ← From Python extraction
                args=arguments,     # ← From Python extraction
                headers=HttpHeaderPayload(root=dict(runtime_headers))
            ),
            global_context=hook_global_context,
            local_contexts=plugin_context_table,
            violations_as_exceptions=True,
        )
        
        # 3. ✅ Use modified payload from hooks
        if pre_result.modified_payload:
            modified_args = pre_result.modified_payload.args  # ← Modified by plugin!
            if pre_result.modified_payload.name:
                tool_name_original = pre_result.modified_payload.name
            if pre_result.modified_payload.headers:
                plugin_headers = pre_result.modified_payload.headers.root
                for hk, hv in plugin_headers.items():
                    runtime_headers[str(hk).lower()] = str(hv)
    
    # 4. Build execution plan with modified args
    plan: Dict[str, Any] = {
        "eligible": True,
        "transport": transport,
        "serverUrl": gateway_url,
        "remoteToolName": tool_name_original,
        "headers": runtime_headers,  # ← May include plugin-injected headers
        "timeoutMs": int(effective_timeout * 1000),
        "gatewayId": tool_gateway_id,
        "toolName": name,
        "toolId": tool_id or None,
        "serverId": server_id,
        "hasPreInvokeHooks": has_pre_invoke,
        "modifiedArgs": modified_args,  # ← Modified by hooks!
    }
    
    return plan
```

**Why Python Must Parse Params:**

1. **Hook payloads require typed fields:**
   ```python
   ToolPreInvokePayload(name=name, args=arguments)
   ```

2. **Plugins modify params:**
   ```python
   modified_args = pre_result.modified_payload.args  # Plugin changed arguments!
   ```

3. **Modified params returned to Rust:**
   ```python
   plan["modifiedArgs"] = modified_args  # Rust applies these
   ```

---

## Part 4: Why This Design?

### 4.1 Separation of Concerns

| Component | Responsibility | Why |
|-----------|----------------|-----|
| **Rust** | Parse envelope, route by method | Fast path, minimal parsing |
| **Python** | Parse params, execute hooks | Hooks need typed payloads, may modify |

**Rationale:**
- Rust needs `method` for **O(1) dispatch**
- Rust doesn't need `params` internals (forwards to Python)
- Python needs `params` internals for **hook execution**
- Plugins may **modify** params; Python must capture changes

---

### 4.2 Performance Considerations

**Rust parsing (fast):**
```rust
// Parse only envelope
let method = object.get("method").and_then(Value::as_str);  // ~0.01ms
```

**Python parsing (necessary):**
```python
# Parse full body for hooks
body = orjson.loads(await request.body())  # ~0.1ms
name = params["name"]                       # ~0.001ms
arguments = params["arguments"]             # ~0.001ms

# Execute hooks
pre_result = await plugin_manager.invoke_hook(...)  # ~1-50ms
```

**Hook execution dominates parsing cost:**
- Parsing: ~0.1ms
- Hook execution: 1-50ms (plugin-dependent)
- **Conclusion:** Parsing overhead is negligible vs. hook execution

---

### 4.3 Correctness Requirements

**Scenario: Plugin modifies arguments**

```python
# Plugin: ArgumentNormalizerPlugin
async def tool_pre_invoke(self, payload, context):
    # Normalize Unicode in arguments
    normalized_args = {
        k: unicodedata.normalize("NFC", v) if isinstance(v, str) else v
        for k, v in payload.args.items()
    }
    return ToolPreInvokeResult(
        modified_payload=ToolPreInvokePayload(
            name=payload.name,
            args=normalized_args,  # ← Modified!
        )
    )
```

**If Rust didn't forward opaque params:**
```rust
// WRONG: Rust parses and forwards separately
let name = params["name"];
let args = params["arguments"];
// Rust would need to know about ALL possible modifications!
```

**Correct approach:**
```rust
// Rust forwards original bytes
.body(body)  // Original Bytes
// Python parses, runs hooks, returns modified args
```

---

## Part 5: Comparison Table

### 5.1 What Rust vs. Python Extract

| Field | Rust Extracts? | Python Extracts? | Why |
|-------|----------------|------------------|-----|
| `jsonrpc` | ✅ Yes (validation) | ✅ Yes (validation) | Protocol compliance |
| `method` | ✅ Yes (routing) | ✅ Yes (validation) | Dispatch + validation |
| `id` | ✅ Yes (response) | ✅ Yes (response) | JSON-RPC correlation |
| `params` (as Value) | ✅ Yes (opaque) | ❌ No (parses internals) | Rust forwards, Python uses |
| `params.name` | ❌ No | ✅ Yes | Hook payload field |
| `params.arguments` | ❌ No | ✅ Yes | Hook execution, may modify |
| `params.uri` | ❌ No | ✅ Yes | Resource hook payload |
| `params.cursor` | ❌ No | ✅ Yes | Pagination handling |
| `params.server_id` | ❌ No | ✅ Yes | Scope validation |

---

### 5.2 Parsing Responsibilities

| Task | Rust | Python | Rationale |
|------|------|--------|-----------|
| Parse JSON envelope | ✅ | ✅ | Both need method for routing/validation |
| Validate JSON-RPC version | ✅ | ✅ | Protocol compliance |
| Extract `method` | ✅ | ✅ | Routing (Rust) + validation (Python) |
| Extract `params` as Value | ✅ | ❌ | Rust forwards opaque |
| Parse `params` internals | ❌ | ✅ | Python needs for hooks |
| Execute pre-invoke hooks | ❌ | ✅ | Plugins run in Python |
| Capture modified args | ❌ | ✅ | Plugins may change params |
| Return modified args to Rust | ❌ | ✅ | Rust applies to upstream call |

---

## Part 6: Implications for Resolve Endpoints

### 6.1 Why Resolve Endpoints Need Full Body

When implementing `prompts/get/resolve` and `resources/read/resolve`:

**Rust sends:**
```rust
POST /_internal/mcp/prompts/get/resolve
Body: body  // Original bytes: {"method":"prompts/get","params":{"name":"...", "arguments":{...}}}
```

**Python needs:**
```python
body = orjson.loads(await request.body())
name = body["params"]["name"]            // For hook payload
arguments = body["params"]["arguments"]  // For hook execution
```

**Why:**
- Pre-fetch hooks may **modify arguments** (e.g., normalize Unicode, inject credentials)
- Python must **run hooks** and return **modified args** to Rust
- Rust applies modified args to the direct DB query

---

### 6.2 Modified Args Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Resolve Flow with Hook Modification          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Client: {"method":"prompts/get","params":{"name":"p1",        │
│            "arguments":{"query":"héllo"}}}                     │
│                                                                 │
│  Rust: Forward body to Python (opaque)                          │
│                                                                 │
│  Python:                                                        │
│    1. Parse: name="p1", arguments={"query":"héllo"}            │
│    2. Run pre_fetch hooks:                                      │
│       ArgumentNormalizerPlugin: "héllo" → "hello"              │
│    3. Return plan:                                              │
│       {"eligible":true,"modifiedArgs":{"query":"hello"}}       │
│                                                                 │
│  Rust: Apply modified args                                      │
│    Use {"query":"hello"} for DB query instead of original      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**If Rust parsed params:**
- Rust would need to understand **every hook's modification semantics**
- Rust would need to **re-serialize** modified params
- **Duplication of logic** between Rust and Python

**With opaque forwarding:**
- Rust forwards bytes (simple)
- Python parses, runs hooks, returns modified args (correct)
- Rust applies modified args (clean)

---

## Part 7: Common Misconceptions

### ❌ Misconception 1: "Rust doesn't parse the request"

**Reality:** Rust **does** parse the JSON-RPC envelope (`method`, `id`, `jsonrpc`), just not the `params` internals.

**Correct statement:**
> "Rust parses the envelope for routing, forwards params opaque to Python."

---

### ❌ Misconception 2: "Python re-parses what Rust already parsed"

**Reality:** Rust and Python parse **different parts**:
- Rust: envelope (`method`, `id`, `jsonrpc`)
- Python: full body including `params` internals

**No duplication** because:
- Rust doesn't parse `params.name`, `params.arguments`, etc.
- Python needs these for hook execution

---

### ❌ Misconception 3: "Rust could parse params to save Python work"

**Reality:** Even if Rust parsed params, Python would **still need to parse** because:
- Hooks may **modify** params
- Python must capture **modified** values
- Rust would need to **re-serialize** modified params

**Net result:** No savings, added complexity.

---

### ❌ Misconception 4: "Opaque forwarding is inefficient"

**Reality:**
- Rust forwards `Bytes` (zero-copy in many cases)
- Python parses once (~0.1ms with orjson)
- Hook execution dominates (1-50ms)

**Parsing overhead is negligible** vs. hook execution.

---

## Part 8: Design Principles

### 8.1 Clean Separation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Parsing Responsibility Matrix                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Rust MCP Runtime:                                              │
│    ✓ Parse envelope (method, id, jsonrpc)                      │
│    ✓ Route by method                                            │
│    ✓ Forward params opaque                                      │
│    ✓ Apply modified args from Python                            │
│                                                                 │
│  Python Gateway:                                                │
│    ✓ Parse full body (envelope + params)                       │
│    ✓ Extract method-specific fields                            │
│    ✓ Execute hooks with typed payloads                         │
│    ✓ Capture modified params                                   │
│    ✓ Return modified params to Rust                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 8.2 Why This Works

1. **Fast routing**: Rust dispatches by method in O(1)
2. **Correct hooks**: Python runs hooks with full context
3. **No duplication**: Each layer parses what it needs
4. **Clean interface**: Rust ↔ Python contract is simple (forward body, return plan)
5. **Extensible**: New hook types don't require Rust changes

---

## Appendix A: Code References

| Component | File | Line | Function |
|-----------|------|------|----------|
| Rust decode | `tools_rust/mcp_runtime/src/lib.rs` | 2590 | `decode_request()` |
| Rust routing | `tools_rust/mcp_runtime/src/lib.rs` | 1590 | `handle_post_request()` |
| Rust resolve call | `tools_rust/mcp_runtime/src/lib.rs` | 8164 | `resolve_tools_call_plan_via_backend()` |
| Python resolve handler | `mcpgateway/main.py` | 9069 | `handle_internal_mcp_tools_call_resolve()` |
| Python hook check | `mcpgateway/services/tool_service.py` | 2940 | `prepare_rust_mcp_tool_execution()` |
| Python hook execution | `mcpgateway/services/tool_service.py` | 3200 | `prepare_rust_mcp_tool_execution()` (pre_invoke section) |

---

## Appendix B: JsonRpcRequest Struct

```rust
// File: tools_rust/mcp_runtime/src/lib.rs:196-206

#[derive(Debug, Clone, Deserialize)]
/// Minimal JSON-RPC request envelope accepted by the runtime edge.
pub struct JsonRpcRequest {
    pub jsonrpc: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub id: Option<Value>,
}
```

**Key:** `params: Value` is **opaque** - Rust doesn't inspect internals.

---

## Appendix C: Example Request/Response

### Client Request
```json
POST /mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "git_commit",
    "arguments": {
      "message": "Fix bug in hélper function",
      "files": ["src/main.py"]
    }
  },
  "id": 1
}
```

### Rust Parsing
```rust
// Parsed by Rust:
method = "tools/call"
id = 1
jsonrpc = "2.0"
params = {"name":"git_commit","arguments":{"message":"Fix bug in hélper function",...}}  // Opaque Value

// NOT parsed by Rust:
params.name = "git_commit"           // ← Opaque
params.arguments.message = "..."     // ← Opaque
params.arguments.files = [...]       // ← Opaque
```

### Python Parsing
```python
# Parsed by Python:
method = "tools/call"
name = "git_commit"
arguments = {
    "message": "Fix bug in hélper function",
    "files": ["src/main.py"]
}
```

### Hook Execution
```python
# ArgumentNormalizerPlugin runs:
normalized_args = {
    "message": "Fix bug in helper function",  # NFC normalized
    "files": ["src/main.py"]
}

# Returned to Rust:
{
    "eligible": True,
    "modifiedArgs": normalized_args,
    "hasPreInvokeHooks": True
}
```

### Rust Execution
```rust
// Rust applies modified args:
upstream_call(
    name="git_commit",
    arguments={"message":"Fix bug in helper function", "files":["src/main.py"]}  // Modified!
)
```

---

**End of Document**
