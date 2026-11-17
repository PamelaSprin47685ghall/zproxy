namespace ZProxy

open System
open System.Buffers
open System.Collections.Generic
open System.IO
open System.Net
open System.Security.Cryptography
open System.Text
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting
open Microsoft.AspNetCore.Http
open Microsoft.AspNetCore.Server.Kestrel.Core
open Microsoft.Extensions.Hosting
open Microsoft.Extensions.Logging

module Management =
    [<Literal>]
    let private CookieName = "zproxy-admin"

    exception private RequestError of int * string

    let private reject status message = raise (RequestError(status, message))

    let private digest (value: string) =
        let bytes = Encoding.UTF8.GetBytes(value)
        try SHA256.HashData(bytes)
        finally CryptographicOperations.ZeroMemory(bytes.AsSpan())

    type private Sessions(password: string) =
        let gate = obj ()
        let expected = digest password
        let values = Dictionary<string, DateTimeOffset>(StringComparer.Ordinal)
        let attempts = Queue<int64>()
        let loginGate = new SemaphoreSlim(1, 1)

        let key value = Convert.ToHexString(digest value)
        let removeExpired now =
            let expired = values |> Seq.filter (fun pair -> pair.Value <= now) |> Seq.map (fun pair -> pair.Key) |> Seq.toArray
            for value in expired do values.Remove(value) |> ignore

        member _.LoginAsync(value: string, ct: CancellationToken) = task {
            let! entered = loginGate.WaitAsync(0, ct)
            if not entered then return Error 429
            else
                try
                    let admitted = lock gate (fun () ->
                        let now = Environment.TickCount64
                        while attempts.Count > 0 && now - attempts.Peek() >= 60000L do attempts.Dequeue() |> ignore
                        if attempts.Count >= 8 then false
                        else attempts.Enqueue(now); true)
                    if not admitted then return Error 429
                    else
                        let supplied = digest value
                        let matches =
                            try CryptographicOperations.FixedTimeEquals(expected, supplied)
                            finally CryptographicOperations.ZeroMemory(supplied.AsSpan())
                        if not matches then return Error 401
                        else
                            let token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32))
                            lock gate (fun () ->
                                let now = DateTimeOffset.UtcNow
                                removeExpired now
                                if values.Count >= 64 then
                                    let oldest = values |> Seq.minBy (fun pair -> pair.Value)
                                    values.Remove(oldest.Key) |> ignore
                                values.Add(key token, now.AddMinutes(30.0)))
                            return Ok token
                finally loginGate.Release() |> ignore
        }

        member _.HasAccess(context: HttpContext) =
            match context.Request.Cookies.TryGetValue(CookieName) with
            | true, value when value.Length = 64 ->
                lock gate (fun () ->
                    let now = DateTimeOffset.UtcNow
                    removeExpired now
                    values.ContainsKey(key value))
            | _ -> false

        member _.Logout(context: HttpContext) =
            match context.Request.Cookies.TryGetValue(CookieName) with
            | true, value when value.Length = 64 -> lock gate (fun () -> values.Remove(key value) |> ignore)
            | _ -> ()

        interface IDisposable with
            member _.Dispose() =
                CryptographicOperations.ZeroMemory(expected.AsSpan())
                lock gate (fun () -> values.Clear(); attempts.Clear())
                loginGate.Dispose()

    let private isLoopback (context: HttpContext) =
        let address = context.Connection.RemoteIpAddress
        address <> null && IPAddress.IsLoopback(address)

    let private isHttps (context: HttpContext) =
        context.Request.IsHttps
        || (isLoopback context
            && context.Request.Headers["X-Forwarded-Proto"].Count = 1
            && context.Request.Headers["X-Forwarded-Proto"].[0] = "https")

    let private requirePrivateTransport (context: HttpContext) =
        let forwarded =
            [ "X-Forwarded-Proto"; "X-Forwarded-For"; "Forwarded" ]
            |> List.exists context.Request.Headers.ContainsKey
        if not (isHttps context || (isLoopback context && not forwarded)) then
            reject 403 "管理操作需要 HTTPS 或本机连接。"

    let private requireOrigin (context: HttpContext) =
        let values = context.Request.Headers.Origin
        let scheme = if isHttps context then "https" else "http"
        let expected = Uri(scheme + "://" + context.Request.Host.Value)
        let valid =
            if values.Count <> 1 then false
            else
                match Uri.TryCreate(values[0], UriKind.Absolute) with
                | true, origin ->
                    origin.Scheme = expected.Scheme && origin.Host = expected.Host && origin.Port = expected.Port
                    && origin.UserInfo = "" && origin.AbsolutePath = "/" && origin.Query = "" && origin.Fragment = ""
                | _ -> false
        if not valid then reject 403 "请从当前管理页面提交操作。"

    let private cookieOptions context =
        CookieOptions(HttpOnly = true, Secure = isHttps context, SameSite = SameSiteMode.Strict,
                      Path = "/admin", MaxAge = Nullable(TimeSpan.FromMinutes(30.0)), IsEssential = true)

    let private readString (context: HttpContext) name = task {
        let contentType = context.Request.ContentType
        if isNull contentType || not (contentType.Split(';').[0].Trim().Equals("application/json", StringComparison.OrdinalIgnoreCase)) then
            reject 415 "请使用 JSON 请求。"
        use body = new MemoryStream(4096)
        let buffer = Array.zeroCreate<byte> 1024
        let mutable reading = true
        while reading do
            let! count = context.Request.Body.ReadAsync(buffer.AsMemory(), context.RequestAborted)
            if count = 0 then reading <- false
            else
                if body.Length + int64 count > 4096L then reject 413 "请求过大。"
                body.Write(buffer, 0, count)
        try
            use document = JsonDocument.Parse(ReadOnlyMemory<byte>(body.ToArray()), JsonDocumentOptions(MaxDepth = 4))
            let root = document.RootElement
            if root.ValueKind <> JsonValueKind.Object then reject 400 "请求格式不正确。"
            let fields = root.EnumerateObject() |> Seq.toArray
            if fields.Length <> 1 || fields[0].Name <> name || fields[0].Value.ValueKind <> JsonValueKind.String then
                reject 400 "请求字段不正确。"
            return fields[0].Value.GetString()
        with :? JsonException -> return reject 400 "请求格式不正确。"
    }

    let private writeJson (context: HttpContext) status (write: Utf8JsonWriter -> unit) = task {
        context.Response.StatusCode <- status
        context.Response.ContentType <- "application/json; charset=utf-8"
        use writer = new Utf8JsonWriter(context.Response.BodyWriter :> IBufferWriter<byte>)
        write writer
        writer.Flush()
        do! context.Response.Body.FlushAsync(context.RequestAborted)
    }

    let private writeError context status (message: string) =
        writeJson context status (fun writer ->
            writer.WriteStartObject()
            writer.WriteString("error", message)
            writer.WriteEndObject())

    let private writeUser (writer: Utf8JsonWriter) (user: Users.UserInfo) =
        writer.WriteStartObject()
        writer.WriteString("id", user.Id)
        writer.WriteString("nickname", user.Nickname)
        writer.WriteBoolean("enabled", user.Enabled)
        writer.WriteString("createdAt", user.CreatedAt)
        writer.WriteEndObject()

    let private writeIssued context status (issued: Users.IssuedUser) =
        writeJson context status (fun writer ->
            writer.WriteStartObject()
            writer.WritePropertyName("user")
            writeUser writer issued.User
            writer.WriteString("uuid", issued.Uuid)
            writer.WriteEndObject())

    /// This public projection never receives a user record or credential.
    let private writeReport context (rows: Statistics.ReportRow[]) =
        writeJson context 200 (fun writer ->
            writer.WriteStartObject()
            writer.WriteStartArray("users")
            for row in rows do
                writer.WriteStartObject()
                writer.WriteString("nickname", row.Nickname)
                writer.WriteNumber("requests", row.Requests)
                writer.WriteNumber("succeeded", row.Succeeded)
                writer.WriteNumber("failed", row.Failed)
                writer.WriteNumber("canceled", row.Canceled)
                writer.WriteNumber("active", row.Active)
                writer.WriteNumber("requestBytes", row.RequestBytes)
                writer.WriteNumber("responseBytes", row.ResponseBytes)
                writer.WriteNumber("durationMs", row.DurationMs)
                writer.WriteEndObject()
            writer.WriteEndArray()
            writer.WriteEndObject())

    let private style = """
:root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;background:#f4f6fa;color:#172334}
*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:42px auto;padding:0 24px}
header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:28px}
h1{font-size:29px;line-height:1.25;margin:0 0 8px}h2{font-size:20px;margin:0 0 18px}p{margin:6px 0;color:#526174}
a{color:#245bc2;text-decoration:none}a:hover{text-decoration:underline}.card{background:white;border:1px solid #dde3ed;border-radius:14px;padding:24px;margin:20px 0}
.row{display:flex;align-items:end;gap:12px;flex-wrap:wrap}label{display:block;font-size:14px;color:#44556a;margin-bottom:6px}
input,textarea,button{font:inherit}input,textarea{padding:10px 12px;border:1px solid #bec9d9;border-radius:7px;background:white;color:#172334}
input{min-width:240px;max-width:100%}textarea{width:100%;resize:vertical;font-family:ui-monospace,monospace;font-size:16px}
button{border:0;border-radius:7px;background:#245bc2;color:white;padding:11px 17px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
button.secondary{background:#eaf0fa;color:#24509a}button.danger{background:#fbe9e9;color:#a12828}.actions{display:flex;gap:8px;flex-wrap:wrap}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:left;font-size:14px}
th{font-weight:600;color:#64748b;border-bottom:1px solid #dce3ee;padding:12px}td{border-bottom:1px solid #edf0f5;padding:13px 12px}
td:first-child{font-weight:600;color:#263c59}tr:last-child td{border-bottom:0}.message{min-height:25px;margin:14px 0;color:#a12828}
.muted{font-size:14px;color:#66768b}.empty{padding:30px;text-align:center;color:#66768b}.secret{border-color:#f0cf85;background:#fffaf0}
[hidden]{display:none!important}@media(max-width:680px){main{margin:24px auto;padding:0 14px}header{align-items:start}h1{font-size:24px}.card{padding:18px}input{min-width:0;width:100%}.row>div{flex:1}}
"""

    let private reportPage = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>zproxy · 使用统计</title><style nonce="%NONCE%">%STYLE%</style></head><body><main>
<header><div><h1>使用统计</h1><p>按昵称汇总的服务器统计，无需登录。</p></div><a href="/admin">用户管理</a></header>
<section class="card"><div class="row"><div><h2>累计用量</h2><p class="muted">请求结果、原始正文流量与耗时由服务器记录。此页不显示账户凭据。</p></div><button id="refresh" class="secondary" type="button">刷新</button></div>
<p id="message" class="message" role="status"></p><div class="table-wrap"><table><thead><tr><th>昵称</th><th>请求</th><th>成功</th><th>失败</th><th>取消</th><th>进行中</th><th>上传</th><th>下行</th><th>平均耗时</th></tr></thead><tbody id="rows"></tbody></table></div><p id="empty" class="empty" hidden>暂无用户统计。</p><p id="updated" class="muted"></p></section>
</main><script nonce="%NONCE%">
const rows=document.querySelector('#rows'), message=document.querySelector('#message'), refreshButton=document.querySelector('#refresh');
const bytes=value=>value<1024?value+' B':value<1048576?(value/1024).toFixed(1)+' KiB':(value/1048576).toFixed(1)+' MiB';
async function refresh(){
  refreshButton.disabled=true;
  try{
    const response=await fetch('/api/reports',{credentials:'omit',cache:'no-store'});
    if(!response.ok)throw new Error('暂时无法读取统计。');
    const data=await response.json();rows.replaceChildren();
    for(const user of data.users){
      const row=document.createElement('tr'), completed=user.succeeded+user.failed+user.canceled;
      const values=[user.nickname,user.requests,user.succeeded,user.failed,user.canceled,user.active,bytes(user.requestBytes),bytes(user.responseBytes),completed?Math.round(user.durationMs/completed)+' ms':'—'];
      for(const value of values){const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);}rows.append(row);
    }
    document.querySelector('#empty').hidden=data.users.length!==0;message.textContent='';document.querySelector('#updated').textContent='更新于 '+new Date().toLocaleTimeString();
  }catch(error){message.textContent=error.message;}finally{refreshButton.disabled=false;}
}
refreshButton.addEventListener('click',refresh);refresh();setInterval(refresh,15000);
</script></body></html>"""

    let private adminPage = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>zproxy · 用户管理</title><style nonce="%NONCE%">%STYLE%</style></head><body><main>
<header><div><h1>用户管理</h1><p>主密码解锁管理；每位用户使用独立 UUID。</p></div><a href="/reports">公开统计</a></header>
<p id="message" class="message" role="status"></p>
<section id="login" class="card"><h2>解锁</h2><form id="loginForm" class="row"><div><label for="password">主密码</label><input id="password" type="password" autocomplete="current-password" required maxlength="1024"></div><button type="submit">解锁管理</button></form><p class="muted">请通过 HTTPS 或本机连接打开此页。</p></section>
<section id="panel" hidden><div class="card"><div class="row"><div><h2>新建用户</h2><form id="createForm" class="row"><div><label for="nickname">昵称</label><input id="nickname" autocomplete="off" required maxlength="64" placeholder="例如：小林"></div><button type="submit">生成用户 UUID</button></form></div><button id="logout" class="secondary" type="button">锁定管理</button></div></div>
<div id="issued" class="card secret" hidden><h2>请保存这次生成的 UUID</h2><p id="issuedName"></p><p class="muted">页面不会保存或再次列出这个密钥。请将它单独交给对应用户。</p><label for="uuid">用户 UUID</label><textarea id="uuid" rows="2" readonly spellcheck="false" autocomplete="off"></textarea><div class="actions"><button id="copy" type="button">复制 UUID</button><button id="hide" class="secondary" type="button">已保存，隐藏</button></div></div>
<div class="card"><h2>用户</h2><div class="table-wrap"><table><thead><tr><th>昵称</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="users"></tbody></table></div><p id="empty" class="empty" hidden>还没有用户。可以先生成一个 UUID。</p></div></section>
</main><script nonce="%NONCE%">
const message=document.querySelector('#message'), users=document.querySelector('#users'), panel=document.querySelector('#panel'), login=document.querySelector('#login');
async function api(path,method='GET',body){
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=response.status===204?null:await response.json();
  if(!response.ok){const error=new Error(data.error||'操作未完成。');error.status=response.status;throw error;}return data;
}
function clearSecret(){document.querySelector('#uuid').value='';document.querySelector('#issuedName').textContent='';document.querySelector('#issued').hidden=true;}
function showSecret(data){document.querySelector('#issuedName').textContent='昵称：'+data.user.nickname;document.querySelector('#uuid').value=data.uuid;document.querySelector('#issued').hidden=false;}
async function loadUsers(){
  try{
    const data=await api('/admin/api/users');users.replaceChildren();
    for(const user of data.users){
      const row=document.createElement('tr');
      for(const value of [user.nickname,user.enabled?'可用':'已停用',new Date(user.createdAt).toLocaleString()]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
      const actions=document.createElement('td'), rotate=document.createElement('button');rotate.className='secondary';rotate.textContent='更新 UUID';
      rotate.addEventListener('click',async()=>{if(!confirm('更新后旧 UUID 立即失效。继续更新 '+user.nickname+'？'))return;await act(async()=>{showSecret(await api('/admin/api/users/'+encodeURIComponent(user.id)+'/rotate','POST'));await loadUsers();});});actions.append(rotate);
      if(user.enabled){const revoke=document.createElement('button');revoke.className='danger';revoke.textContent='停用';revoke.addEventListener('click',async()=>{if(!confirm('停用 '+user.nickname+' 后，其连接将结束。继续？'))return;await act(async()=>{await api('/admin/api/users/'+encodeURIComponent(user.id),'DELETE');clearSecret();await loadUsers();});});actions.append(document.createTextNode(' '),revoke);}
      row.append(actions);users.append(row);
    }
    document.querySelector('#empty').hidden=data.users.length!==0;panel.hidden=false;login.hidden=true;
  }catch(error){if(error.status===401){panel.hidden=true;login.hidden=false;clearSecret();}else throw error;}
}
async function act(work){message.textContent='';try{await work();}catch(error){message.textContent=error.message;if(error.status===401){panel.hidden=true;login.hidden=false;clearSecret();}}}
document.querySelector('#loginForm').addEventListener('submit',event=>{event.preventDefault();act(async()=>{const input=document.querySelector('#password'), password=input.value;input.value='';await api('/admin/login','POST',{password});await loadUsers();});});
document.querySelector('#createForm').addEventListener('submit',event=>{event.preventDefault();act(async()=>{showSecret(await api('/admin/api/users','POST',{nickname:document.querySelector('#nickname').value}));document.querySelector('#nickname').value='';await loadUsers();});});
document.querySelector('#logout').addEventListener('click',()=>act(async()=>{await api('/admin/logout','POST');clearSecret();await loadUsers();}));
document.querySelector('#hide').addEventListener('click',clearSecret);
document.querySelector('#copy').addEventListener('click',()=>act(async()=>{await navigator.clipboard.writeText(document.querySelector('#uuid').value);message.textContent='已复制。请单独交给对应用户。';}));
window.addEventListener('pagehide',clearSecret);act(loadUsers);
</script></body></html>"""

    let private writePage (context: HttpContext) page = task {
        let nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))
        context.Response.Headers.ContentSecurityPolicy <-
            $"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        context.Response.ContentType <- "text/html; charset=utf-8"
        do! context.Response.WriteAsync((page: string).Replace("%STYLE%", style).Replace("%NONCE%", nonce), context.RequestAborted)
    }

    let private handle (sessions: Sessions) (users: Users.Store) (statistics: Statistics.Store) (context: HttpContext) = task {
        context.Response.Headers.CacheControl <- "no-store"
        context.Response.Headers.XContentTypeOptions <- "nosniff"
        context.Response.Headers["Referrer-Policy"] <- "no-referrer"
        try
            let path = context.Request.Path.Value
            let method = context.Request.Method
            match method, path with
            | "GET", "/" | "GET", "/reports" -> do! writePage context reportPage
            | "GET", "/api/reports" -> do! writeReport context (statistics.Snapshot())
            | "GET", "/admin" | "GET", "/admin/" ->
                requirePrivateTransport context
                do! writePage context adminPage
            | "POST", "/admin/login" ->
                requirePrivateTransport context
                requireOrigin context
                let! password = readString context "password"
                let! result = sessions.LoginAsync(password, context.RequestAborted)
                match result with
                | Ok token ->
                    context.Response.Cookies.Append(CookieName, token, cookieOptions context)
                    do! writeJson context 200 (fun writer -> writer.WriteStartObject(); writer.WriteBoolean("unlocked", true); writer.WriteEndObject())
                | Error 429 ->
                    context.Response.Headers.RetryAfter <- "60"
                    do! writeError context 429 "尝试次数较多，请稍后再试。"
                | Error _ -> do! writeError context 401 "主密码不正确。"
            | _ when path.StartsWith("/admin/", StringComparison.Ordinal) ->
                requirePrivateTransport context
                if not (sessions.HasAccess(context)) then reject 401 "请先解锁管理。"
                if method <> "GET" then requireOrigin context
                match method, path with
                | "POST", "/admin/logout" ->
                    sessions.Logout(context)
                    context.Response.Cookies.Delete(CookieName, cookieOptions context)
                    context.Response.StatusCode <- 204
                | "GET", "/admin/api/users" ->
                    do! writeJson context 200 (fun writer ->
                        writer.WriteStartObject()
                        writer.WriteStartArray("users")
                        for user in users.List() do writeUser writer user
                        writer.WriteEndArray()
                        writer.WriteEndObject())
                | "POST", "/admin/api/users" ->
                    let! nickname = readString context "nickname"
                    do! writeIssued context 201 (users.Create(nickname))
                | _ ->
                    let parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries)
                    match method, parts with
                    | "POST", [| "admin"; "api"; "users"; id; "rotate" |] -> do! writeIssued context 200 (users.Rotate(id))
                    | "DELETE", [| "admin"; "api"; "users"; id |] ->
                        if users.Revoke(id) then context.Response.StatusCode <- 204
                        else reject 404 "没有这个可用用户。"
                    | _ -> reject 404 "没有这个页面或操作。"
            | _ -> reject 404 "没有这个页面或操作。"
        with
        | RequestError(status, message) -> do! writeError context status message
        | :? ArgumentException -> do! writeError context 400 "昵称无效或已经存在。"
        | :? KeyNotFoundException -> do! writeError context 404 "没有这个用户。"
        | :? InvalidOperationException -> do! writeError context 409 "操作冲突或用户数量已达到上限。"
        | :? Microsoft.AspNetCore.Http.BadHttpRequestException -> do! writeError context 413 "请求过大或格式不正确。"
        | :? OperationCanceledException when context.RequestAborted.IsCancellationRequested -> context.Abort()
        | _ ->
            if context.Response.HasStarted then context.Abort()
            else do! writeError context 500 "操作未完成，请稍后重试。"
    }

    let run (listen: IPEndPoint, masterPassword: string, users: Users.Store,
             statistics: Statistics.Store, ct: CancellationToken) : Task = task {
        if String.IsNullOrWhiteSpace(masterPassword) || Encoding.UTF8.GetByteCount(masterPassword) > 1024 then
            invalidArg "masterPassword" "The master password must contain 1 to 1024 UTF-8 bytes."
        use sessions = new Sessions(masterPassword)
        // Same rule as the client listener: the host never depends on the process
        // working directory, which a service manager may set to a directory the
        // default content-root probe cannot use.
        let builder =
            WebApplication.CreateSlimBuilder(
                WebApplicationOptions(ContentRootPath = AppContext.BaseDirectory, Args = [||]))
        builder.Logging.ClearProviders() |> ignore
        builder.WebHost.ConfigureKestrel(fun server ->
            server.AddServerHeader <- false
            server.Limits.MaxConcurrentConnections <- Nullable 64L
            server.Limits.MaxRequestBodySize <- Nullable 4096L
            server.Limits.MaxRequestHeaderCount <- 64
            server.Limits.MaxRequestHeadersTotalSize <- 16384
            server.Limits.RequestHeadersTimeout <- TimeSpan.FromSeconds(15.0)
            server.Listen(listen.Address, listen.Port, fun endpoint -> endpoint.Protocols <- HttpProtocols.Http1)) |> ignore
        let app = builder.Build()
        let request (context: HttpContext) = task {
            use request = CancellationTokenSource.CreateLinkedTokenSource(ct, context.RequestAborted)
            context.RequestAborted <- request.Token
            do! handle sessions users statistics context
        }
        app.Run(RequestDelegate(fun context -> request context :> Task))
        do! (app :> IHost).RunAsync(ct)
    }
