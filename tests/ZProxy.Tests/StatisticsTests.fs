namespace ZProxy.Tests

open System
open System.IO
open System.Threading.Tasks
open Xunit
open ZProxy

module StatisticsTests =
    type private Folder() =
        let path = Path.Combine(Path.GetTempPath(), "zproxy-statistics-" + Guid.NewGuid().ToString("N"))
        do Directory.CreateDirectory(path) |> ignore
        member _.Path = path
        member _.File = Path.Combine(path, "stats.json")
        interface IDisposable with member _.Dispose() = Directory.Delete(path, true)

    let private identity (user: Users.UserInfo) : Users.Identity = { Id = user.Id; Nickname = user.Nickname }

    [<Fact>]
    let ``Reports contain per-user outcomes bytes duration and active work`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let alice = users.Create("Alice")
        let bob = users.Create("Bob")
        use stats = new Statistics.Store(folder.Path, users.List)
        use first = stats.Begin(identity alice.User)
        use second = stats.Begin(identity alice.User)
        use other = stats.Begin(identity bob.User)
        first.Finish(Statistics.Succeeded, 5L, 10L, 20L)
        other.Finish(Statistics.Failed, 7L, 3L, 9L)
        let rows = stats.Snapshot()
        let row = rows |> Array.find (fun row -> row.Nickname = "Alice")
        Assert.Equal(2L, row.Requests)
        Assert.Equal(1L, row.Succeeded)
        Assert.Equal(1L, row.Active)
        Assert.Equal(5L, row.RequestBytes)
        Assert.Equal(10L, row.ResponseBytes)
        Assert.Equal(20L, row.DurationMs)
        let otherRow = rows |> Array.find (fun row -> row.Nickname = "Bob")
        Assert.Equal(1L, otherRow.Failed)
        Assert.Equal(0L, otherRow.Active)
        second.Finish(Statistics.Canceled, 2L, 4L, 6L)
        let closed = stats.Snapshot() |> Array.find (fun row -> row.Nickname = "Alice")
        Assert.Equal(0L, closed.Active)
        Assert.Equal(1L, closed.Canceled)
        Assert.Equal(7L, closed.RequestBytes)
        Assert.Equal(14L, closed.ResponseBytes)

    [<Fact>]
    let ``Finishing and disposing an activity record only one outcome`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("once")
        use stats = new Statistics.Store(folder.Path, users.List)
        let work = stats.Begin(identity user.User)
        work.Finish(Statistics.Succeeded, 3L, 4L, 5L)
        work.Finish(Statistics.Failed, 100L, 100L, 100L)
        (work :> IDisposable).Dispose()
        let row = Assert.Single(stats.Snapshot())
        Assert.Equal(1L, row.Requests)
        Assert.Equal(1L, row.Succeeded)
        Assert.Equal(0L, row.Failed)
        Assert.Equal(0L, row.Canceled)
        Assert.Equal(4L, row.ResponseBytes)
        do
            use pending = stats.Begin(identity user.User)
            ()
        let after = Assert.Single(stats.Snapshot())
        Assert.Equal(2L, after.Requests)
        Assert.Equal(1L, after.Canceled)
        Assert.Equal(0L, after.Active)

    [<Fact>]
    let ``Aggregate history survives restart and UUID rotation`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let first = users.Create("history")
        do
            use stats = new Statistics.Store(folder.Path, users.List)
            use work = stats.Begin(identity first.User)
            work.Finish(Statistics.Succeeded, 123L, 456L, 789L)
            stats.Flush()
        let next = users.Rotate(first.User.Id)
        use reopened = new Statistics.Store(folder.Path, users.List)
        let row = Assert.Single(reopened.Snapshot())
        Assert.Equal("history", row.Nickname)
        Assert.Equal(1L, row.Requests)
        Assert.Equal(456L, row.ResponseBytes)
        use more = reopened.Begin(identity next.User)
        more.Finish(Statistics.Failed, 1L, 2L, 3L)
        reopened.Flush()
        let saved = File.ReadAllText(folder.File)
        Assert.DoesNotContain(first.Uuid, saved)
        Assert.DoesNotContain(next.Uuid, saved)
        Assert.DoesNotContain("selector", saved)
        Assert.DoesNotContain("key", saved)
        if not (OperatingSystem.IsWindows()) then
            Assert.Equal(UnixFileMode.UserRead ||| UnixFileMode.UserWrite, File.GetUnixFileMode(folder.File))

    [<Fact>]
    let ``Active work is not restored as a running request after restart`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("restart")
        let stats = new Statistics.Store(folder.Path, users.List)
        use doneWork = stats.Begin(identity user.User)
        doneWork.Finish(Statistics.Succeeded, 1L, 2L, 3L)
        use unfinished = stats.Begin(identity user.User)
        Assert.Equal(1L, Assert.Single(stats.Snapshot()).Active)
        stats.Flush()
        (stats :> IDisposable).Dispose()
        use reopened = new Statistics.Store(folder.Path, users.List)
        let restored = Assert.Single(reopened.Snapshot())
        Assert.Equal(0L, restored.Active)
        Assert.Equal(1L, restored.Requests)

    [<Fact>]
    let ``Public row fields cannot expose credentials or internal IDs`` () =
        let names = typeof<Statistics.ReportRow>.GetProperties() |> Array.map (fun property -> property.Name) |> Array.sort
        let expected =
            [| "Nickname"; "Requests"; "Succeeded"; "Failed"; "Canceled"; "Active"
               "RequestBytes"; "ResponseBytes"; "DurationMs" |] |> Array.sort
        Assert.Equal<string>(expected, names)

    [<Fact>]
    let ``New and revoked users keep their public nickname rows`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        use stats = new Statistics.Store(folder.Path, users.List)
        let user = users.Create("visible")
        Assert.Equal("visible", Assert.Single(stats.Snapshot()).Nickname)
        users.Revoke(user.User.Id) |> ignore
        Assert.Equal("visible", Assert.Single(stats.Snapshot()).Nickname)
        Assert.Equal(0L, Assert.Single(stats.Snapshot()).Requests)

    [<Fact>]
    let ``Unknown users and negative counters are rejected`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let issued = users.Create("valid")
        use stats = new Statistics.Store(folder.Path, users.List)
        Assert.Throws<ArgumentException>(fun () -> stats.Begin({ Id = "missing"; Nickname = "spoofed" }) |> ignore) |> ignore
        use work = stats.Begin(identity issued.User)
        Assert.Throws<ArgumentException>(fun () -> work.Finish(Statistics.Succeeded, -1L, 0L, 0L)) |> ignore
        work.Finish(Statistics.Succeeded, 1L, 2L, 3L)
        Assert.Equal(1L, Assert.Single(stats.Snapshot()).Succeeded)

    [<Fact>]
    let ``Concurrent completion cannot duplicate an activity`` () = task {
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("concurrent")
        use stats = new Statistics.Store(folder.Path, users.List)
        use work = stats.Begin(identity user.User)
        let attempts = Array.init 32 (fun _ -> Task.Run(fun () -> work.Finish(Statistics.Succeeded, 2L, 3L, 4L)))
        do! Task.WhenAll(attempts)
        let row = Assert.Single(stats.Snapshot())
        Assert.Equal(1L, row.Requests)
        Assert.Equal(0L, row.Active)
        Assert.Equal(2L, row.RequestBytes)
    }

    [<Theory>]
    [<InlineData("{\"version\":2,\"users\":[]}")>]
    [<InlineData("{\"version\":1,\"version\":1,\"users\":[]}")>]
    [<InlineData("{\"version\":1,\"users\":[{\"id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"requests\":1,\"succeeded\":1,\"failed\":0,\"canceled\":0,\"requestBytes\":1,\"responseBytes\":1,\"durationMs\":1}]}")>]
    let ``Invalid or mismatched statistics are not silently accepted`` (text: string) =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        File.WriteAllText(folder.File, text)
        Assert.Throws<InvalidDataException>(fun () -> new Statistics.Store(folder.Path, users.List) |> ignore) |> ignore

    [<Fact>]
    let ``A failed flush retains pending counters for the next flush`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let user = users.Create("disk retry")
        use stats = new Statistics.Store(folder.Path, users.List)
        use work = stats.Begin(identity user.User)
        work.Finish(Statistics.Succeeded, 5L, 6L, 7L)
        Directory.CreateDirectory(folder.File) |> ignore
        try Assert.ThrowsAny<IOException>(fun () -> stats.Flush()) |> ignore
        finally Directory.Delete(folder.File)
        stats.Flush()
        (stats :> IDisposable).Dispose()
        use reopened = new Statistics.Store(folder.Path, users.List)
        Assert.Equal(6L, Assert.Single(reopened.Snapshot()).ResponseBytes)
