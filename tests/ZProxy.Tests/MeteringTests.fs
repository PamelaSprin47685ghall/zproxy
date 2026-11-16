namespace ZProxy.Tests

open System
open System.IO
open System.Net
open System.Net.Http
open System.Threading
open System.Threading.Tasks
open Xunit
open ZProxy

module MeteringTests =
    type private Folder() =
        let path = Path.Combine(Path.GetTempPath(), "zproxy-metering-" + Guid.NewGuid().ToString("N"))
        do Directory.CreateDirectory(path) |> ignore
        member _.Path = path
        interface IDisposable with member _.Dispose() = Directory.Delete(path, true)

    let private identity (issued: Users.IssuedUser) : Users.Identity =
        { Id = issued.User.Id; Nickname = issued.User.Nickname }

    let private reply bytes : Contracts.RemoteReply =
        let response = new HttpResponseMessage(HttpStatusCode.OK)
        response.Content <- new ByteArrayContent(bytes)
        { Response = response; Metadata = Contracts.identity("test-request", false) }

    [<Fact>]
    let ``A gateway failure before its response closes the activity once`` () = task {
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("failed") |> identity
        use stats = new Statistics.Store(folder.Path, users.List)
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/completions")
        request.Content <- new ByteArrayContent("hello"B)
        let handler: RemoteHandler = fun _ request token -> task {
            let! _ = request.Content.ReadAsByteArrayAsync(token)
            return raise (IOException("The gateway did not return a response."))
        }
        let send = Metering.wrap stats handler
        let! _ = Assert.ThrowsAsync<IOException>(fun () -> send user request CancellationToken.None :> Task)
        request.Dispose()
        let row = Assert.Single(stats.Snapshot())
        Assert.Equal(1L, row.Requests)
        Assert.Equal(1L, row.Failed)
        Assert.Equal(0L, row.Succeeded)
        Assert.Equal(0L, row.Canceled)
        Assert.Equal(0L, row.Active)
        Assert.Equal(5L, row.RequestBytes)
        Assert.Equal(0L, row.ResponseBytes)
    }

    [<Fact>]
    let ``Canceling before response EOF records partial bytes and releases the activity`` () = task {
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("canceled") |> identity
        use stats = new Statistics.Store(folder.Path, users.List)
        use stop = new CancellationTokenSource()
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        let handler: RemoteHandler = fun _ _ _ -> Task.FromResult(reply "reply"B)
        let! result = (Metering.wrap stats handler) user request stop.Token
        use response = result.Response
        let! body = response.Content.ReadAsStreamAsync(stop.Token)
        let buffer = Array.zeroCreate<byte> 2
        let! received = body.ReadAsync(buffer.AsMemory(), stop.Token)
        Assert.Equal(2, received)
        Assert.Equal(1L, Assert.Single(stats.Snapshot()).Active)
        stop.Cancel()
        response.Dispose()
        response.Dispose()
        let row = Assert.Single(stats.Snapshot())
        Assert.Equal(1L, row.Requests)
        Assert.Equal(1L, row.Canceled)
        Assert.Equal(0L, row.Failed)
        Assert.Equal(0L, row.Succeeded)
        Assert.Equal(0L, row.Active)
        Assert.Equal(0L, row.RequestBytes)
        Assert.Equal(2L, row.ResponseBytes)
    }

    [<Fact>]
    let ``Reading a complete successful reply records both byte counts once`` () = task {
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("complete") |> identity
        use stats = new Statistics.Store(folder.Path, users.List)
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        request.Content <- new ByteArrayContent("request"B)
        let handler: RemoteHandler = fun _ request token -> task {
            let! bytes = request.Content.ReadAsByteArrayAsync(token)
            Assert.Equal<byte>("request"B, bytes)
            return reply "response"B
        }
        let! result = (Metering.wrap stats handler) user request CancellationToken.None
        use response = result.Response
        let! bytes = response.Content.ReadAsByteArrayAsync(CancellationToken.None)
        Assert.Equal<byte>("response"B, bytes)
        response.Dispose()
        request.Dispose()
        let row = Assert.Single(stats.Snapshot())
        Assert.Equal(1L, row.Requests)
        Assert.Equal(1L, row.Succeeded)
        Assert.Equal(0L, row.Failed)
        Assert.Equal(0L, row.Canceled)
        Assert.Equal(0L, row.Active)
        Assert.Equal(7L, row.RequestBytes)
        Assert.Equal(8L, row.ResponseBytes)
        Assert.True(row.DurationMs >= 0L)
    }
