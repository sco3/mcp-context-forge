# Rust MCP Plugin Hook Execution Flow

**Document Purpose:** Complete execution flow analysis showing how plugin hooks are executed in Python path vs. bypassed in Rust direct-DB path for `prompts/get` and `resources/read` methods.

**Date:** 2026-04-01  
**Related Issue:** Rust MCP plugin hook semantics inconsistency

---

## Executive Summary

### The Bug

Rust MCP runtime executes **direct database queries** for `prompts/get` and `resources/read` without checking for active plugin hooks, thereby **bypassing plugin semantics** that Python path guarantees.

### Impact

| Hook Family | Python Path | Rust Path | Status |
|-------------|-------------|-----------|--------|
| `tool_pre_invoke` | ✅ Executed | ✅ Executed (via resolve) | Working |
| `tool_post_invoke` | ✅ Executed | ⚠️ Forces Python fallback | Working (performance penalty) |
| `prompt_pre_fetch` | ✅ Executed | ❌ **BYPASSED** | **BUG** |
| `prompt_post_fetch` | ✅ Executed | ❌ **BYPASSED** | **BUG** |
| `resource_pre_fetch` | ✅ Executed | ❌ **BYPASSED** | **BUG** |
| `resource_post_fetch` | ✅ Executed | ❌ **BYPASSED** | **BUG** |

---

## Part 1: Python Execution Flow (Correct Behavior)

### Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PYTHON PATH (with hooks)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  Client → SSE → message_endpoint → broadcast → respond → generate_response │
│     ↓                                                                      │
│  /rpc → handle_rpc → _handle_rpc_authenticated → dispatch by method        │
│     ↓                                                                      │
│  prompt_service.get_prompt() OR resource_service.read_resource()           │
│     ↓                                                                      │
│  1. Check has_pre_fetch / has_post_fetch hooks                             │
│     ↓                                                                      │
│  2. Run pre_fetch hooks (if any) ← PluginManager.invoke_hook()             │
│     ↓                                                                      │
│  3. Fetch from DB/gateway                                                  │
│     ↓                                                                      │
│  4. Run post_fetch hooks (if any) ← PluginManager.invoke_hook()            │
│     ↓                                                                      │
│  5. Return result to client                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Step-by-Step Execution for `prompts/get`

#### **Step 1: Client Establishes SSE Connection**

```python
File: mcpgateway/main.py
Line: 4057
Function: sse_endpoint(request, server_id, db, user)
```

**What happens:**
- Client connects to `/servers/{server_id}/sse`
- Creates `SSETransport` instance
- Registers session in `session_registry`
- Spawns background `respond()` task
- Returns SSE response stream

**Key code:**
```python
# Line 4088-4092
transport = SSETransport(base_url=server_sse_url)
await transport.connect()
await session_registry.add_session(transport.session_id, transport)
await session_registry.set_session_owner(transport.session_id, get_user_email(user))

# Line 4134 - Create respond task BEFORE SSE response (critical ordering)
respond_task = asyncio.create_task(
    session_registry.respond(server_id, user_with_token, session_id=transport.session_id)
)
session_registry.register_respond_task(transport.session_id, respond_task)
```

---

#### **Step 2: Client Sends MCP Message**

```python
File: mcpgateway/main.py
Line: 4174
Function: message_endpoint(request, server_id, user)
```

**What happens:**
- Client POSTs JSON-RPC to `/servers/{server_id}/message?session_id=xxx`
- Extracts `session_id` from query params
- Reads JSON body
- Calls `session_registry.broadcast()` to deliver message

**Request example:**
```json
{
  "jsonrpc": "2.0",
  "method": "prompts/get",
  "params": {
    "name": "my_prompt",
    "arguments": {"key": "value"}
  },
  "id": 1
}
```

**Key code:**
```python
# Line 4200-4203
message = await _read_request_json(request)

# Line 4225-4229
await session_registry.broadcast(
    session_id=session_id,
    message=message,
)
```

---

#### **Step 3: Message Delivery via Broadcast**

```python
File: mcpgateway/cache/session_registry.py
Line: ~1380
Function: broadcast(session_id, message)
```

**What happens:**
- Stores message in backend (memory/redis/database)
- Other workers poll/fetch the message via their `respond()` tasks
- Triggers message processing

**Backend-specific behavior:**
- **Memory**: Stores in `self._session_message` dict
- **Redis**: Publishes to Redis pubsub channel
- **Database**: Inserts into `SessionMessageRecord` table

---

#### **Step 4: Background Respond Task Processes Message**

```python
File: mcpgateway/cache/session_registry.py
Line: 1472
Function: respond(server_id, user, session_id)
```

**What happens:**
- Listens for messages (backend-specific mechanism)
- When message arrives, calls `generate_response()`

**Memory backend example (lines 1520-1525):**
```python
transport = self.get_session_sync(session_id)
if transport and self._session_message:
    message_json = self._session_message.get("message")
    data = orjson.loads(message_json)
    message = data.get("message", {})
    await self.generate_response(message=message, transport=transport, server_id=server_id, user=user)
```

**Database backend polling (lines 1760-1795):**
```python
# Adaptive polling with exponential backoff
while True:
    session, record = await asyncio.to_thread(_db_read_session_and_message, session_id)
    
    if not session:
        break  # Session gone, stop polling
    
    if record:
        poll_interval = settings.poll_interval  # Reset on activity
        data = orjson.loads(record.message)
        message = data.get("message", {})
        transport = self.get_session_sync(session_id)
        if transport:
            await self.generate_response(
                message=message,
                transport=transport,
                server_id=server_id,
                user=user,
            )
            await asyncio.to_thread(_db_remove, session_id, record.message)
    else:
        # No message - backoff
        poll_interval = min(poll_interval * backoff_factor, max_interval)
```

---

#### **Step 5: Generate Response via Loopback RPC**

```python
File: mcpgateway/cache/session_registry.py
Line: 2231
Function: generate_response(message, transport, server_id, user)
```

**What happens:**
- Extracts method and params from message
- Builds JSON-RPC request
- POSTs to internal `/rpc` endpoint via loopback (127.0.0.1)
- Receives response and sends via SSE transport

**Key code (lines 2260-2280):**
```python
method = message["method"]  # "prompts/get"
params = message.get("params", {})
params["server_id"] = server_id
req_id = message["id"]

rpc_input = {
    "jsonrpc": "2.0",
    "method": method,
    "params": params,
    "id": req_id,
}

# Build auth headers from user context
token = user.get("auth_token")  # From SSE endpoint
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
}

# Forward passthrough headers (e.g., X-Upstream-Authorization)
passthrough = user.get("_passthrough_headers") or {}
if passthrough and isinstance(passthrough, dict):
    headers.update(filter_loopback_skip_headers(passthrough))

# POST to internal /rpc endpoint
rpc_url = f"{internal_loopback_base_url()}/rpc"  # http://127.0.0.1:4444/rpc

async with ResilientHttpClient(client_args={"timeout": settings.federation_timeout}) as client:
    rpc_response = await client.post(
        url=rpc_url,
        json=rpc_input,
        headers=headers,
    )
    result = rpc_response.json().get("result", {})
```

---

#### **Step 6: Internal RPC Handler**

```python
File: mcpgateway/main.py
Line: 6986
Function: handle_rpc(request, db, user)
```

**What happens:**
- Receives authenticated RPC request
- Delegates to `_handle_rpc_authenticated()`

**Key code (line 6997):**
```python
return await _handle_rpc_authenticated(request, db=db, user=user)
```

---

#### **Step 7: Authenticated RPC Dispatcher**

```python
File: mcpgateway/main.py
Line: 9271
Function: _handle_rpc_authenticated(request, db, user)
```

**What happens:**
- Parses JSON-RPC request
- Extracts auth context (user email, teams, admin status)
- Checks RBAC permissions
- Dispatches to appropriate service method

**Auth context extraction (lines 9320-9340):**
```python
body = orjson.loads(await request.body())
method = body["method"]  # "prompts/get"
req_id = body.get("id")
params = body.get("params", {})
server_id = params.get("server_id")

# Extract user email, token_teams, is_admin
auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
# See: main.py:776 _get_rpc_filter_context()
#   - Gets user email from user object
#   - Gets normalized teams from JWT token
#   - Gets is_admin from internal auth context

# Check RBAC permission
await _ensure_rpc_permission(user, db, "prompts.read", method, request=request)
# See: main.py:980 _ensure_rpc_permission()
#   - Layer 1: Token scope permissions
#   - Layer 2: RBAC role-based check
```

**Method dispatch (lines 9608-9640):**
```python
elif method == "prompts/get":
    await _ensure_rpc_permission(user, db, "prompts.read", method, request=request)
    name = params.get("name")
    arguments = params.get("arguments", {})
    meta_data = params.get("_meta", None)
    
    if not name:
        raise JSONRPCError(-32602, "Missing prompt name in parameters", params)
    
    # Get authorization context
    auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
    if auth_is_admin and auth_token_teams is None:
        auth_user_email = None  # Admin unrestricted
    elif auth_token_teams is None:
        auth_token_teams = []  # Non-admin without teams = public-only
    
    # Get plugin contexts from request.state (set by middleware)
    plugin_context_table = getattr(request.state, "plugin_context_table", None)
    plugin_global_context = getattr(request.state, "plugin_global_context", None)
    
    # CALL PROMPT SERVICE
    result = await prompt_service.get_prompt(
        db,
        name,
        arguments,
        user=auth_user_email,
        server_id=server_id,
        token_teams=auth_token_teams,
        plugin_context_table=plugin_context_table,
        plugin_global_context=plugin_global_context,
        _meta_data=meta_data,
    )
```

---

#### **Step 8: Prompt Service - get_prompt()**

```python
File: mcpgateway/services/prompt_service.py
Line: ~1788
Function: PromptService.get_prompt(self, db, name, arguments, ...)
```

This is where **plugin hooks are checked and executed**.

---

##### **8.1 Check for Active Hooks**

```python
# Line 1853-1854
has_pre_fetch = self._plugin_manager and self._plugin_manager.has_hooks_for(PromptHookType.PROMPT_PRE_FETCH)
has_post_fetch = self._plugin_manager and self._plugin_manager.has_hooks_for(PromptHookType.PROMPT_POST_FETCH)

# Line 1856-1870: Initialize plugin context only if hooks exist
context_table = None
global_context = None
if has_pre_fetch or has_post_fetch:
    context_table = plugin_context_table
    if plugin_global_context:
        global_context = plugin_global_context
        global_context.user = user
        global_context.server_id = server_id
        global_context.tenant_id = tenant_id
    else:
        # Create new context (fallback when middleware didn't run)
        if not request_id:
            request_id = uuid.uuid4().hex
        global_context = GlobalContext(
            request_id=request_id,
            user=user,
            server_id=server_id,
            tenant_id=tenant_id,
        )
```

**Plugin manager check:**
```python
# File: mcpgateway/plugins/framework/manager.py
# Line: 723
def has_hooks_for(self, hook_type: str) -> bool:
    """Check if any enabled plugins have hooks for the given hook type."""
    return self._registry.has_hooks_for(hook_type)

# File: mcpgateway/plugins/framework/registry.py
# Line: 179
def has_hooks_for(self, hook_type: str) -> bool:
    """Check if registry has any hooks for the given type."""
    hook_refs = self.hooks.get(hook_type, [])
    return any(hook_ref.plugin_ref.mode != PluginMode.DISABLED for hook_ref in hook_refs)
```

---

##### **8.2 Run Pre-Fetch Hooks (if any)**

```python
# Line 1878-1888
if has_pre_fetch:
    pre_result, context_table = await self._plugin_manager.invoke_hook(
        PromptHookType.PROMPT_PRE_FETCH,
        payload=PromptPrehookPayload(prompt_id=prompt_id, args=arguments),
        global_context=global_context,
        local_contexts=context_table,  # Pass context from previous hooks
        violations_as_exceptions=True,
    )
    
    # Use modified payload if provided
    if pre_result.modified_payload:
        payload = pre_result.modified_payload
        arguments = payload.args
```

**Hook invocation details:**
```python
# File: mcpgateway/plugins/framework/manager.py
# Line: ~840
async def invoke_hook(
    self,
    hook_type: str,
    payload: PluginPayload,
    global_context: GlobalContext,
    local_contexts: Optional[PluginContextTable] = None,
    violations_as_exceptions: bool = False,
) -> tuple[PluginResult, PluginContextTable | None]:
    """Invoke plugins configured for the hook point in priority order."""
    
    # Get plugins configured for this hook
    hook_refs = self._registry.get_hook_refs_for_hook(hook_type=hook_type)
    
    # Execute plugins in priority order
    result, contexts = await self._executor.execute(
        plugins=hook_refs,
        payload=payload,
        global_context=global_context,
        plugin_run=...,
        compare=...,
    )
    
    return result, contexts
```

**Example plugins with `prompt_pre_fetch` hooks:**
- `ArgumentNormalizerPlugin` - Normalizes Unicode, whitespace, casing
- `PIIFilterPlugin` - Detects and masks PII
- `DenyListPlugin` - Blocks forbidden words
- `RateLimiterPlugin` - Per-user/tenant rate limits

---

##### **8.3 Fetch Prompt from Database**

```python
# Line 1893-1920
search_key = str(prompt_id)

# Build base query with server + team scoping
base_query = select(DbPrompt).options(joinedload(DbPrompt.gateway)).where(DbPrompt.enabled)
if server_id:
    base_query = base_query.join(
        server_prompt_association,
        DbPrompt.id == server_prompt_association.c.prompt_id
    ).where(server_prompt_association.c.server_id == server_id)

# Apply team/access control
scoped_query = await self._apply_access_control(base_query, db, user, token_teams, team_id=None)

# Find prompt by name or ID
prompt = self._find_prompt_by_name_or_id(db, scoped_query, prompt_id)

# If not found in active prompts, check inactive
if not prompt:
    inactive_base_query = select(DbPrompt).options(joinedload(DbPrompt.gateway)).where(not_(DbPrompt.enabled))
    if server_id:
        inactive_base_query = inactive_base_query.join(
            server_prompt_association,
            DbPrompt.id == server_prompt_association.c.prompt_id
        ).where(server_prompt_association.c.server_id == server_id)
    inactive_scoped_query = await self._apply_access_control(inactive_base_query, db, user, token_teams, team_id=None)
    
    inactive_prompt = self._find_prompt_by_name_or_id(db, inactive_scoped_query, prompt_id)
    
    if inactive_prompt:
        raise PromptNotFoundError(f"Prompt '{search_key}' exists but is inactive")
    
    raise PromptNotFoundError(f"Prompt not found: {search_key}")

# Enforce server scoping
if server_id:
    server_match = db.execute(
        select(server_prompt_association.c.prompt_id).where(
            server_prompt_association.c.server_id == server_id,
            server_prompt_association.c.prompt_id == prompt.id,
        )
    ).first()
    if not server_match:
        raise PromptNotFoundError(f"Prompt not found: {search_key}")
```

---

##### **8.4 Render Prompt**

```python
# Line 1933-1957
if self._should_fetch_gateway_prompt(prompt):
    # Release read transaction before network I/O
    db.commit()
    result = await self._fetch_gateway_prompt_result(prompt, arguments, user)
elif not arguments:
    result = PromptResult(
        messages=[
            Message(
                role=Role.USER,
                content=TextContent(type="text", text=prompt.template),
            )
        ],
        description=prompt.description,
    )
else:
    prompt.validate_arguments(arguments)
    rendered = self._render_template(prompt.template, arguments)
    messages = self._parse_messages(rendered)
    result = PromptResult(messages=messages, description=prompt.description)
```

---

##### **8.5 Run Post-Fetch Hooks (if any)**

```python
# Line 1966-1976
if has_post_fetch:
    post_result, _ = await self._plugin_manager.invoke_hook(
        PromptHookType.PROMPT_POST_FETCH,
        payload=PromptPosthookPayload(prompt_id=prompt.name, result=result),
        global_context=global_context,
        local_contexts=context_table,
        violations_as_exceptions=True,
    )
    # Use modified payload if provided
    result = post_result.modified_payload.result if post_result.modified_payload else result
```

**Example plugins with `prompt_post_fetch` hooks:**
- `PIIFilterPlugin` - Mask PII in output
- `PromptOutputSentinelPlugin` - Append sentinel for testing
- `MarkdownCleanerPlugin` - Tidy Markdown formatting
- `VirusTotalURLCheckerPlugin` - Check URLs in output

---

##### **8.6 Record Metrics and Return**

```python
# Line 1995-2025
audit_trail.log_action(
    user_id=user or "anonymous",
    action="view_prompt",
    resource_type="prompt",
    resource_id=str(prompt.id),
    resource_name=prompt.name,
    team_id=prompt.team_id,
    context={
        "tenant_id": tenant_id,
        "server_id": server_id,
        "arguments_provided": arguments_supplied,
        "request_id": request_id,
    },
    db=db,
)

metrics_buffer.record_prompt_metric(
    prompt_id=prompt.id,
    start_time=start_time,
    success=success,
    error_message=error_message,
)

set_span_attribute(span, "success", True)
set_span_attribute(span, "duration.ms", (time.monotonic() - start_time) * 1000)

logger.info(f"Retrieved prompt: {prompt.id} successfully")
return result
```

---

#### **Step 9: Response Path Back to Client**

```
_handle_rpc_authenticated() returns result
    ↓
handle_rpc() returns ORJSONResponse
    ↓
generate_response() receives HTTP response
    ↓
SSE transport sends via send_message()
    ↓
Client receives SSE event
```

**Key code (session_registry.py, lines 2350-2360):**
```python
response = {"jsonrpc": "2.0", "result": result, "id": req_id}
logging.debug(f"Sending sse message:{response}")
await transport.send_message(response)
```

---

### Step-by-Step Execution for `resources/read`

Same pattern as `prompts/get`, but with resource-specific service:

**Dispatcher (main.py:9513-9560):**
```python
elif method == "resources/read":
    await _ensure_rpc_permission(user, db, "resources.read", method, request=request)
    uri = params.get("uri")
    request_id = params.get("requestId", None)
    meta_data = params.get("_meta", None)
    
    if not uri:
        raise JSONRPCError(-32602, "Missing resource URI in parameters", params)
    
    auth_user_email, auth_token_teams, auth_is_admin = _get_rpc_filter_context(request, user)
    if auth_is_admin and auth_token_teams is None:
        auth_user_email = None
    elif auth_token_teams is None:
        auth_token_teams = []
    
    plugin_context_table = getattr(request.state, "plugin_context_table", None)
    plugin_global_context = getattr(request.state, "plugin_global_context", None)
    
    try:
        result = await resource_service.read_resource(
            db,
            resource_uri=uri,
            request_id=request_id,
            user=auth_user_email,
            server_id=server_id,
            token_teams=auth_token_teams,
            plugin_context_table=plugin_context_table,
            plugin_global_context=plugin_global_context,
            meta_data=meta_data,
        )
        if hasattr(result, "model_dump"):
            result = {"contents": [result.model_dump(by_alias=True, exclude_none=True)]}
        else:
            result = {"contents": [result]}
    except (ValueError, ResourceNotFoundError):
        raise JSONRPCError(-32002, f"Resource not found: {uri}", {"uri": uri})
```

**Resource Service:**
```python
File: mcpgateway/services/resource_service.py
Line: ~2140
Function: ResourceService.read_resource(self, db, resource_uri, ...)
```

**Hook checks (lines 2177-2178):**
```python
plugin_eligible = bool(self._plugin_manager and PLUGINS_AVAILABLE and uri and ("://" in uri))

has_pre_fetch = plugin_eligible and self._plugin_manager.has_hooks_for(ResourceHookType.RESOURCE_PRE_FETCH)
has_post_fetch = plugin_eligible and self._plugin_manager.has_hooks_for(ResourceHookType.RESOURCE_POST_FETCH)
```

**Pre-fetch hooks (lines 2214-2225):**
```python
if has_pre_fetch:
    pre_payload = ResourcePreFetchPayload(uri=uri, metadata={})
    
    pre_result, contexts = await self._plugin_manager.invoke_hook(
        ResourceHookType.RESOURCE_PRE_FETCH,
        pre_payload,
        global_context,
        local_contexts=plugin_context_table,
        violations_as_exceptions=True,
    )
    
    # Use modified URI if plugin changed it
    if pre_result.modified_payload:
        uri = pre_result.modified_payload.uri
        logger.debug(f"Resource URI modified by plugin: {original_uri} -> {uri}")
```

**Post-fetch hooks (lines 2486-2495):**
```python
if has_post_fetch:
    post_payload = ResourcePostFetchPayload(uri=uri, result=result)
    
    post_result, _ = await self._plugin_manager.invoke_hook(
        ResourceHookType.RESOURCE_POST_FETCH,
        post_payload,
        global_context,
        contexts,
        violations_as_exceptions=True,
    )
    
    # Use modified payload if provided
    if post_result.modified_payload:
        result = post_result.modified_payload.result
```

---

## Part 2: Rust Execution Flow (BUG - Hooks Bypassed)

### Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RUST PATH (hooks BYPASSED for prompts/resources)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Client → Rust MCP Runtime → validate authz → DIRECT DB QUERY → Response   │
│                                              ↑                               │
│                                      NO HOOK CHECK! ❌                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### tools/call (Working Correctly with Resolve Pattern)

```python
File: tools_rust/mcp_runtime/src/lib.rs
Line: ~8060
Function: handle_tools_call()
```

**Flow:**
```rust
// Line 8063-8085
let plan = match resolve_tools_call(state, &incoming_headers, &request, body.clone()).await {
    Ok(plan) => plan,
    Err(ResolveToolsCallError::Fallback(err)) => {
        // Fall back to Python
        return forward_tools_call_to_backend(state, incoming_headers, body).await;
    }
};

// Line 8106-8115
if !plan.eligible {
    if let Some(reason) = plan.fallback_reason.as_deref() {
        info!("Rust MCP direct tools/call falling back to Python: {reason}");
    }
    return forward_tools_call_to_backend(state, incoming_headers, body).await;
}

// If eligible, execute directly in Rust
match execute_tools_call_direct(state, &incoming_headers, &request, &plan, &trace_context).await {
    Ok(response) => response,
    Err(err) => {
        // Execution failed, fall back to Python
        return forward_tools_call_to_backend(state, incoming_headers, body).await;
    }
}
```

**Resolve endpoint call (lines 8164-8207):**
```rust
async fn resolve_tools_call_plan_via_backend(
    state: &AppState,
    incoming_headers: &HeaderMap,
    body: Bytes,
) -> Result<ResolvedMcpToolCallPlan, ResolveToolsCallError> {
    let response = state
        .client
        .post(state.backend_tools_call_resolve_url())
        .headers(build_forwarded_headers(incoming_headers))
        .body(body)
        .send()
        .await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resolve request failed: {err}")))?;
    
    let status = response.status();
    let response_body = response.bytes().await
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resolve read failed: {err}")))?;
    
    let mut plan = serde_json::from_slice::<ResolvedMcpToolCallPlan>(&response_body)
        .map_err(|err| ResolveToolsCallError::Fallback(format!("resolve decode failed: {err}")))?;
    
    Ok(plan)
}
```

**Python resolve endpoint:**
```python
File: mcpgateway/main.py
Line: 9069
Function: handle_internal_mcp_tools_call_resolve(request)
```

**Hook check in Python (tool_service.py:2940-2945):**
```python
has_pre_invoke = self._plugin_manager and self._plugin_manager.has_hooks_for(ToolHookType.TOOL_PRE_INVOKE)
has_post_invoke = self._plugin_manager and self._plugin_manager.has_hooks_for(ToolHookType.TOOL_POST_INVOKE)

# Line 3200-3202
if has_post_invoke:
    native_post_invoke_retry_policy, requires_python_fallback = self._build_rust_native_tool_post_invoke_retry_policy(name, hook_global_context)
    if requires_python_fallback:
        return {"eligible": False, "fallbackReason": "post-invoke-hooks-configured"}
```

**Result:** ✅ Hooks are respected - either executed (pre_invoke) or forces Python fallback (post_invoke)

---

### prompts/get (BUG - Direct DB, No Hook Check)

```python
File: tools_rust/mcp_runtime/src/lib.rs
Line: ~5280
Function: handle_prompts_get()
```

**Current flow (BUGGY):**
```rust
// Line 5291-5305
let server_id = incoming_headers
    .get("x-contextforge-server-id")
    .and_then(|value| value.to_str().ok())
    .map(str::to_string);

let auth_context = decode_internal_auth_context_from_headers(&incoming_headers);

let (Some(server_id), Ok(auth_context)) = (server_id, auth_context) else {
    warn!("Rust MCP direct prompts/get missing trusted context; falling back to Python dispatcher");
    return forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await;
};

// Line 5318-5325
// Extract prompt name from params
let Some(name) = params.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
    return forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await;
};

// Line 5325-5340
// Check authorization via backend (only checks RBAC, NOT hooks!)
let authz_decision = match authorize_server_method_via_backend(...).await {
    Ok(decision) => decision,
    Err(response) => return response,
};
if !authz_decision.direct_execution_eligible {
    return forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await;
}

// Line 5398-5435
// ❌ DIRECT DB QUERY - NO HOOK CHECK!
match query_server_prompt_get_from_db(state, &server_id, &auth_context, &prompt_name).await {
    Ok(Some(payload)) => {
        // Return directly from DB
        json_response(StatusCode::OK, json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "result": payload,
        }))
    }
    Ok(None) => {
        // Not found
        json_response(jsonrpc_response_status(StatusCode::NOT_FOUND), ...)
    }
    Err(RuntimeError::Config(reason)) if reason == "fallback-python" => {
        debug!("Rust MCP direct prompts/get falling back to Python dispatcher for prompt '{prompt_name}'");
        forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await
    }
    Err(err) => {
        error!("Rust MCP direct prompts/get DB query failed: {err}; falling back to Python dispatcher");
        forward_prompts_get_to_backend(state, incoming_headers, body, request_id).await
    }
}
```

**Problem:** No call to a resolve endpoint that checks for active hooks!

---

### resources/read (BUG - Direct DB, No Hook Check)

```python
File: tools_rust/mcp_runtime/src/lib.rs
Line: ~5160
Function: handle_resources_read()
```

**Current flow (BUGGY):**
```rust
// Similar pattern to prompts/get
// Line 5172-5185
let (Some(server_id), Ok(auth_context)) = (server_id, auth_context) else {
    warn!("Rust MCP direct resources/read missing trusted context; falling back to Python dispatcher");
    return forward_resources_read_to_backend(state, incoming_headers, body, request_id).await;
};

// Line 5191-5205
// Check authorization via backend (only RBAC, NOT hooks!)
let authz_decision = match authorize_server_method_via_backend(...).await {
    Ok(decision) => decision,
    Err(response) => return response,
};
if !authz_decision.direct_execution_eligible {
    return forward_resources_read_to_backend(state, incoming_headers, body, request_id).await;
}

// Line 5228-5270
// ❌ DIRECT DB QUERY - NO HOOK CHECK!
match query_server_resource_read_from_db(state, &server_id, &auth_context, uri).await {
    Ok(Some(payload)) => {
        // Return directly from DB
        json_response(StatusCode::OK, json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "result": payload,
        }))
    }
    // ... error handling
}
```

**Problem:** Same as prompts/get - no hook eligibility check!

---

## Part 3: Comparison Summary

### Python Path (Correct)

| Step | Component | Hook Check |
|------|-----------|------------|
| 1. SSE connection | `main.py:sse_endpoint()` | N/A |
| 2. Message receipt | `main.py:message_endpoint()` | N/A |
| 3. Message delivery | `session_registry.py:broadcast()` | N/A |
| 4. Respond task | `session_registry.py:respond()` | N/A |
| 5. Loopback RPC | `session_registry.py:generate_response()` | N/A |
| 6. RPC handler | `main.py:handle_rpc()` | N/A |
| 7. Dispatcher | `main.py:_handle_rpc_authenticated()` | N/A |
| 8. **Service method** | `prompt_service.py:get_prompt()` | ✅ **YES** |
| 8a. Check hooks | Line 1853-1854 | ✅ `has_hooks_for()` |
| 8b. Pre-fetch hooks | Line 1878-1888 | ✅ `invoke_hook(PROMPT_PRE_FETCH)` |
| 8c. DB fetch | Line 1893-1920 | N/A |
| 8d. Post-fetch hooks | Line 1966-1976 | ✅ `invoke_hook(PROMPT_POST_FETCH)` |
| 9. Response | `session_registry.py:send_message()` | N/A |

### Rust Path (BUGGY)

| Step | Component | Hook Check |
|------|-----------|------------|
| 1. Client request | Rust MCP runtime | N/A |
| 2. Authz check | `authorize_server_method_via_backend()` | ❌ RBAC only |
| 3. **Direct DB query** | `query_server_prompt_get_from_db()` | ❌ **NO** |
| 4. Response | Rust HTTP response | N/A |

### Rust Path for tools/call (Correct)

| Step | Component | Hook Check |
|------|-----------|------------|
| 1. Client request | Rust MCP runtime | N/A |
| 2. **Resolve plan** | `resolve_tools_call()` → Python `/tools/call/resolve` | ✅ **YES** |
| 3. Python hook check | `tool_service.py:prepare_rust_mcp_tool_execution()` | ✅ `has_hooks_for()` |
| 4. Plan returned | `{"eligible": bool, "fallbackReason": str}` | ✅ Includes hook status |
| 5. Rust decision | If !eligible → Python fallback | ✅ Respects hooks |
| 6. Direct execution | If eligible → Rust DB | ✅ Safe (no hooks active) |

---

## Part 4: Fix Strategy

### Solution: Add Resolve Endpoints for Prompts and Resources

**Pattern:** Mirror existing `tools/call/resolve` architecture

### New Python Endpoints

1. **`/_internal/mcp/prompts/get/resolve`**
   - File: `mcpgateway/main.py`
   - Function: `handle_internal_mcp_prompts_get_resolve()`
   - Checks: `has_hooks_for(PromptHookType.PROMPT_PRE_FETCH)` and `PROMPT_POST_FETCH`
   - Returns: `{"eligible": bool, "fallbackReason": str, ...}`

2. **`/_internal/mcp/resources/read/resolve`**
   - File: `mcpgateway/main.py`
   - Function: `handle_internal_mcp_resources_read_resolve()`
   - Checks: `has_hooks_for(ResourceHookType.RESOURCE_PRE_FETCH)` and `RESOURCE_POST_FETCH`
   - Returns: `{"eligible": bool, "fallbackReason": str, ...}`

### Rust Runtime Changes

1. **Add resolve plan structs**
   - `ResolvedPromptGetPlan`
   - `ResolvedResourceReadPlan`

2. **Add resolve functions**
   - `resolve_prompts_get_plan_via_backend()`
   - `resolve_resources_read_plan_via_backend()`

3. **Update handlers**
   - `handle_prompts_get()`: Call resolve before DB query
   - `handle_resources_read()`: Call resolve before DB query

4. **Fallback logic**
   - If `!plan.eligible` → `forward_*_to_backend()`

---

## Part 5: Test Scenarios

### Test 1: tool_post_invoke Forces Python Fallback (Already Working)

**Config:** `plugins/config.yaml` with `RetryWithBackoffPlugin` enabled (has `tool_post_invoke` hook)

**Expected:**
```
Rust MCP direct tools/call falling back to Python: post-invoke-hooks-configured
```

**Verify:**
- Rust calls `/tools/call/resolve`
- Python returns `{"eligible": false, "fallbackReason": "post-invoke-hooks-configured"}`
- Rust forwards to Python
- Python executes hooks

---

### Test 2: prompt_post_fetch Forces Python Fallback (NEW - Currently Broken)

**Config:** `plugins/plugin_parity_config.yaml` with `PromptOutputSentinelPlugin` enabled

```yaml
- name: "PromptOutputSentinelPlugin"
  hooks: ["prompt_post_fetch"]
  mode: "enforce"
  conditions:
    - prompts: ["fast-time-convert-time-detailed"]
  config:
    sentinel_text: "[PROMPT-POST-FETCH-SENTINEL]"
```

**Expected:**
```
Rust MCP direct prompts/get falling back to Python: prompt-hooks-configured
```

**Verify:**
- Rust calls `/prompts/get/resolve` (NEW)
- Python returns `{"eligible": false, "fallbackReason": "prompt-hooks-configured"}`
- Rust forwards to Python
- Python executes `prompt_post_fetch` hooks
- Response includes `[PROMPT-POST-FETCH-SENTINEL]`

---

### Test 3: resource_post_fetch Forces Python Fallback (NEW - Currently Broken)

**Config:** `plugins/plugin_parity_config.yaml` with `LicenseHeaderInjector` enabled

```yaml
- name: "LicenseHeaderInjector"
  hooks: ["resource_post_fetch"]
  mode: "enforce"
  conditions:
    - resources: ["time://formats"]
  config:
    header_template: "SPDX-License-Identifier: Apache-2.0"
```

**Expected:**
```
Rust MCP direct resources/read falling back to Python: resource-hooks-configured
```

**Verify:**
- Rust calls `/resources/read/resolve` (NEW)
- Python returns `{"eligible": false, "fallbackReason": "resource-hooks-configured"}`
- Rust forwards to Python
- Python executes `resource_post_fetch` hooks
- Response includes SPDX header

---

## Part 6: Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `mcpgateway/services/prompt_service.py` | Add `_build_rust_prompt_hook_global_context()` | ~3064 |
| `mcpgateway/services/resource_service.py` | Add `_build_rust_resource_hook_global_context()` | ~3850 |
| `mcpgateway/main.py` | Add `/prompts/get/resolve` endpoint | ~9210 |
| `mcpgateway/main.py` | Add `/resources/read/resolve` endpoint | ~9280 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add resolve URL fields to `AppState` | ~125-175 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `ResolvedPromptGetPlan` struct | ~500-600 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `ResolvedResourceReadPlan` struct | ~500-600 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `resolve_prompts_get_plan_via_backend()` | ~8160 |
| `tools_rust/mcp_runtime/src/lib.rs` | Add `resolve_resources_read_plan_via_backend()` | ~8160 |
| `tools_rust/mcp_runtime/src/lib.rs` | Update `handle_prompts_get()` | ~5280 |
| `tools_rust/mcp_runtime/src/lib.rs` | Update `handle_resources_read()` | ~5160 |

---

## Part 7: Key Design Principles

1. **Resolve-before-execute pattern**: Always check hook eligibility before taking direct DB path
2. **Fail-closed**: When hooks are active, fall back to Python (preserve semantics)
3. **Cache resolve plans**: Like tools does, avoid repeated resolve calls for same request shape
4. **Preserve tool_post_invoke fallback**: Already working, don't change
5. **Native Rust hook execution**: Future work (out of scope for this fix)

---

## Appendix A: Hook Type Reference

```python
# File: mcpgateway/plugins/framework/hooks/*.py

# Tool hooks
ToolHookType.TOOL_PRE_INVOKE   # Before tool execution
ToolHookType.TOOL_POST_INVOK   # After tool execution

# Prompt hooks
PromptHookType.PROMPT_PRE_FETCH   # Before prompt retrieval
PromptHookType.PROMPT_POST_FETCH  # After prompt retrieval

# Resource hooks
ResourceHookType.RESOURCE_PRE_FETCH   # Before resource fetch
ResourceHookType.RESOURCE_POST_FETCH  # After resource fetch
```

---

## Appendix B: Example Plugin Configurations

### plugins/config.yaml (Default Stack)

```yaml
plugins:
  - name: "RetryWithBackoffPlugin"
    hooks: ["tool_post_invoke"]
    mode: "permissive"
    # This forces tools/call to fall back to Python
```

### plugins/plugin_parity_config.yaml (Parity Testing)

```yaml
plugins:
  - name: "PromptOutputSentinelPlugin"
    hooks: ["prompt_post_fetch"]
    mode: "enforce"
    # This should force prompts/get to fall back to Python
  
  - name: "LicenseHeaderInjector"
    hooks: ["resource_post_fetch"]
    mode: "enforce"
    # This should force resources/read to fall back to Python
```

---

**End of Document**
