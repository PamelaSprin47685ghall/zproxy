namespace ZProxy.Tests

open System
open System.Collections.Generic
open System.IO
open System.Text.Json
open System.Threading.Tasks
open Xunit
open ZProxy

module UsersTests =
    type private Folder() =
        let path = Path.Combine(Path.GetTempPath(), "zproxy-users-" + Guid.NewGuid().ToString("N"))
        do Directory.CreateDirectory(path) |> ignore
        member _.Path = path
        member _.File = Path.Combine(path, "users.json")
        interface IDisposable with member _.Dispose() = Directory.Delete(path, true)

    [<Fact>]
    let ``User creation persists derived keys without the UUID`` () =
        use folder = new Folder()
        let issued =
            use users = new Users.Store(folder.Path)
            let created = users.Create("  小王  ")
            Assert.Equal("小王", created.User.Nickname)
            Assert.True(created.User.Enabled)
            Assert.NotEqual<string>(created.User.Id, Guid.Parse(created.Uuid).ToString("N"))
            let key = Crypto.deriveUserCredential created.Uuid
            let resolved = users.Resolve(key.Selector).Value
            Assert.Equal(created.User.Id, resolved.Identity.Id)
            Assert.Equal<byte>(key.Key, resolved.Key)
            let stored = File.ReadAllText(folder.File)
            Assert.DoesNotContain(created.Uuid, stored)
            Assert.DoesNotContain(Guid.Parse(created.Uuid).ToString("N"), stored)
            if not (OperatingSystem.IsWindows()) then
                Assert.Equal(UnixFileMode.UserRead ||| UnixFileMode.UserWrite, File.GetUnixFileMode(folder.File))
            created
        use reopened = new Users.Store(folder.Path)
        let credential = Crypto.deriveUserCredential issued.Uuid
        Assert.Equal(issued.User, Assert.Single(reopened.List()))
        Assert.Equal(issued.User.Id, reopened.Resolve(credential.Selector).Value.Identity.Id)

    [<Fact>]
    let ``Resolve returns an independent key and rejects unknown selectors`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let issued = users.Create("reader")
        let credential = Crypto.deriveUserCredential issued.Uuid
        let first = users.Resolve(credential.Selector).Value
        first.Key[0] <- first.Key[0] ^^^ 0xffuy
        Assert.Equal<byte>(credential.Key, users.Resolve(credential.Selector).Value.Key)
        Assert.True(users.Resolve(Array.zeroCreate 32).IsNone)
        Assert.True(users.Resolve(Array.zeroCreate 31).IsNone)
        Assert.True(users.Resolve(null).IsNone)

    [<Fact>]
    let ``Rotation preserves identity and revokes old sessions outside the lock`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let first = users.Create("route user")
        let firstKey = Crypto.deriveUserCredential first.Uuid
        let old = users.Resolve(firstKey.Selector).Value
        let mutable observed = false
        use callback = old.Revoked.Register(fun () ->
            let check = Task.Run(fun () -> users.List().Length)
            observed <- check.Wait(TimeSpan.FromSeconds(2.0)) && check.Result = 1)
        let next = users.Rotate(first.User.Id)
        Assert.True(observed)
        Assert.True(old.Revoked.IsCancellationRequested)
        Assert.Equal(first.User.Id, next.User.Id)
        Assert.Equal(first.User.CreatedAt, next.User.CreatedAt)
        Assert.NotEqual<string>(first.Uuid, next.Uuid)
        Assert.True(users.Resolve(firstKey.Selector).IsNone)
        let nextKey = Crypto.deriveUserCredential next.Uuid
        let active = users.Resolve(nextKey.Selector).Value
        Assert.False(active.Revoked.IsCancellationRequested)
        Assert.Equal(first.User.Id, active.Identity.Id)
        Assert.DoesNotContain(first.Uuid, File.ReadAllText(folder.File))
        Assert.DoesNotContain(next.Uuid, File.ReadAllText(folder.File))

    [<Fact>]
    let ``Revocation removes the key and rotation can issue a fresh one`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let first = users.Create("one")
        let credential = Crypto.deriveUserCredential first.Uuid
        let active = users.Resolve(credential.Selector).Value
        Assert.True(users.Revoke(first.User.Id))
        Assert.False(users.Revoke(first.User.Id))
        Assert.False(users.Revoke("missing"))
        Assert.True(active.Revoked.IsCancellationRequested)
        Assert.True(users.Resolve(credential.Selector).IsNone)
        Assert.False(Assert.Single(users.List()).Enabled)
        let persisted = File.ReadAllText(folder.File)
        Assert.DoesNotContain(Convert.ToBase64String(credential.Key), persisted)
        Assert.DoesNotContain(Convert.ToHexString(credential.Selector), persisted)
        use document = JsonDocument.Parse(persisted)
        let saved = document.RootElement.GetProperty("users").EnumerateArray() |> Seq.head
        Assert.Equal("", saved.GetProperty("key").GetString())
        Assert.Equal("", saved.GetProperty("selector").GetString())
        let restored = users.Rotate(first.User.Id)
        Assert.True(restored.User.Enabled)
        Assert.Equal(first.User.Id, restored.User.Id)
        Assert.True(users.Resolve((Crypto.deriveUserCredential restored.Uuid).Selector).IsSome)

    [<Theory>]
    [<InlineData("")>]
    [<InlineData("   ")>]
    [<InlineData("\nname")>]
    [<InlineData("name\t")>]
    let ``Invalid nicknames are rejected`` name =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        Assert.Throws<ArgumentException>(fun () -> users.Create(name) |> ignore) |> ignore
        Assert.Empty(users.List())

    [<Fact>]
    let ``Nickname length duplicates and missing users are checked`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        users.Create("Alice") |> ignore
        Assert.Throws<ArgumentException>(fun () -> users.Create(" alice ") |> ignore) |> ignore
        Assert.Throws<ArgumentException>(fun () -> users.Create(String('x', 65)) |> ignore) |> ignore
        Assert.Throws<KeyNotFoundException>(fun () -> users.Rotate("missing") |> ignore) |> ignore
        Assert.Single(users.List()) |> ignore

    [<Fact>]
    let ``A failed disk replacement does not change authentication`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let issued = users.Create("keep")
        let credential = Crypto.deriveUserCredential issued.Uuid
        let active = users.Resolve(credential.Selector).Value
        let backup = folder.File + ".backup"
        File.Move(folder.File, backup)
        Directory.CreateDirectory(folder.File) |> ignore
        try
            Assert.ThrowsAny<IOException>(fun () -> users.Rotate(issued.User.Id) |> ignore) |> ignore
            Assert.False(active.Revoked.IsCancellationRequested)
            Assert.True(users.Resolve(credential.Selector).IsSome)
            Assert.ThrowsAny<IOException>(fun () -> users.Create("not saved") |> ignore) |> ignore
            Assert.Single(users.List()) |> ignore
            Assert.Empty(Directory.GetFiles(folder.Path, "*.tmp"))
        finally
            Directory.Delete(folder.File)
            File.Move(backup, folder.File)

    [<Theory>]
    [<InlineData("{\"version\":2,\"users\":[]}")>]
    [<InlineData("{\"version\":1,\"version\":1,\"users\":[]}")>]
    [<InlineData("{\"version\":1,\"users\":[],\"secret\":\"extra\"}")>]
    let ``Stored schema errors do not silently create an empty store`` (text: string) =
        use folder = new Folder()
        File.WriteAllText(folder.File, text)
        Assert.Throws<InvalidDataException>(fun () -> new Users.Store(folder.Path) |> ignore) |> ignore

    [<Fact>]
    let ``Corrupt key lengths and oversized files are rejected`` () =
        use folder = new Folder()
        do
            use users = new Users.Store(folder.Path)
            users.Create("saved") |> ignore
        let source = File.ReadAllText(folder.File)
        use document = JsonDocument.Parse(source)
        let record = document.RootElement.GetProperty("users").EnumerateArray() |> Seq.head
        let key = record.GetProperty("key").GetRawText()
        File.WriteAllText(folder.File, source.Replace(key, "\"bad\""))
        Assert.Throws<InvalidDataException>(fun () -> new Users.Store(folder.Path) |> ignore) |> ignore
        do
            use stream = File.OpenWrite(folder.File)
            stream.SetLength(8L * 1024L * 1024L + 1L)
        Assert.Throws<InvalidDataException>(fun () -> new Users.Store(folder.Path) |> ignore) |> ignore

    [<Fact>]
    let ``Disposal revokes leases and is idempotent`` () =
        use folder = new Folder()
        let users = new Users.Store(folder.Path)
        let issued = users.Create("shutdown")
        let active = users.Resolve((Crypto.deriveUserCredential issued.Uuid).Selector).Value
        (users :> IDisposable).Dispose()
        (users :> IDisposable).Dispose()
        Assert.True(active.Revoked.IsCancellationRequested)
        Assert.Throws<ObjectDisposedException>(fun () -> users.List() |> ignore) |> ignore

    [<Fact>]
    let ``One data directory has only one active user writer`` () =
        use folder = new Folder()
        let first = new Users.Store(folder.Path)
        let issued = first.Create("single writer")
        Assert.Throws<IOException>(fun () -> new Users.Store(folder.Path) |> ignore) |> ignore
        if not (OperatingSystem.IsWindows()) then
            Assert.Equal(UnixFileMode.UserRead ||| UnixFileMode.UserWrite,
                         File.GetUnixFileMode(Path.Combine(folder.Path, "users.lock")))
        (first :> IDisposable).Dispose()
        use next = new Users.Store(folder.Path)
        Assert.Equal(issued.User.Id, Assert.Single(next.List()).Id)

    [<Fact>]
    let ``Recursive disposal keeps ownership until session revocation completes`` () =
        use folder = new Folder()
        use users = new Users.Store(folder.Path)
        let issued = users.Create("shutdown")
        let active = users.Resolve((Crypto.deriveUserCredential issued.Uuid).Selector).Value
        let mutable rejected = false
        use callback = active.Revoked.Register(fun () ->
            (users :> IDisposable).Dispose()
            try
                use other = new Users.Store(folder.Path)
                ()
            with :? IOException -> rejected <- true)
        (users :> IDisposable).Dispose()
        Assert.True(rejected)
        use next = new Users.Store(folder.Path)
        Assert.Equal(issued.User.Id, Assert.Single(next.List()).Id)
