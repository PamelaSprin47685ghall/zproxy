# Linux AppImage

The normal `zproxy-linux-x64` artifact contains the small NativeAOT core. The
optional `zproxy-omp-linux-x64` artifact is a real AppImage containing that core,
Bun, OMP source, its production packages and native addon, a static AG codec, and the non-glibc
shared-library closure. Pass `--omp` to activate the OMP plugin. Merely using
the larger AppImage does not start OMP.

## Build

Use Ubuntu 24.04 x86-64, Python 3.11 or newer, Git, and the .NET SDK selected by
`global.json`. Install `clang`, `libzstd-dev`, `zlib1g-dev`, `libssl-dev`, and
`desktop-file-utils`. Then run from the repository root:

```sh
python3 scripts/prepare-omp.py
python3 scripts/prepare-ag2api.py
plugins/omp/bin/bun run --cwd plugins/omp test
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 --self-contained true -p:PublishAot=true \
  --output artifacts/linux-x64
python3 scripts/smoke-native.py --binary artifacts/linux-x64/ZProxy
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy --omp-dir plugins/omp
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy --omp-dir plugins/omp --antigravity2api
python3 scripts/build-appimage.py --binary artifacts/linux-x64/ZProxy
python3 scripts/smoke-appimage.py --image artifacts/zproxy-omp-linux-x64.AppImage
```

`prepare-omp.py` fetches the newest OMP default-branch commit and the newest Bun
release; `upstream.json` names only where each newest revision comes from.
`--source PATH` and `--bun PATH` use a local checkout or executable instead, and
their own HEAD or version is what gets recorded. `bun.lock` is a build artifact:
the prepare script deletes it and lets Bun resolve the newest catalog and
dependencies without running lifecycle scripts. The OMP patch is idempotent over
one exact anchor per edit, so it reapplies or skips after upstream moves and fails
loudly when the anchor disappears. The routing engine and host bridge live in
this repository (`router/`, `shim/`, `presets/`) and are not fetched or patched
at build time.

`prepare-ag2api.py` fetches the newest Antigravity2API commit and the newest
stable Go toolchain, checks the upstream license, then adds the new files in
`plugins/omp/ag2api` to that module. It runs the three modified Go packages' tests
and builds only `cmd/zproxy-ag` with `CGO_ENABLED=0`, injecting the fetched commit
through `-ldflags -X`. It accepts `--source PATH` and `--go PATH` for local
inputs. The image contains the static worker, build provenance, and linked module
licenses. It does not contain the Go SDK, source checkout, caches, or the upstream
application and its web UI.

A downloaded artifact is checked against the checksum its release publishes when
one exists; a release with no published checksum is still downloaded and recorded
by tag. The build writes the OMP commit, the AG2API commit, the Bun version, the
worker summary, and the addon digest that it actually used into `bundle.json`, so
a later audit reads what ran rather than a separate version table.

## Contents and use

The image includes these important paths:

| Path inside the image | Purpose |
| --- | --- |
| `usr/bin/ZProxy` | NativeAOT core |
| `usr/bin/bun` | Pinned baseline x86-64 Bun |
| `usr/lib/zproxy/omp` | Optional plugin and complete OMP runtime graph |
| `usr/lib/zproxy/omp/bin/zproxy-ag` | Static Antigravity2API protocol worker |
| `usr/lib/zproxy/lib` | zstd, OpenSSL, and non-glibc dependency closure |
| `usr/share/zproxy/bundle.json` | Source, lock, binary, library, and platform provenance |
| `usr/share/licenses/zproxy-omp` | Runtime notices; npm notices also remain in their packages |

For a client, use the same client arguments as the small core and add `--omp`.
Only the server takes `--omp-config`. A server configuration and its credential
database are runtime inputs; neither is copied into the AppImage. `AppRun`
sets the bundled OMP and Bun paths and then passes every argument to the core.
The normal `ZPROXY_OMP_DIR`, `ZPROXY_BUN`, `--omp-dir`, and `--bun` overrides
remain available.

No host Bun, Go, or .NET installation is needed at runtime. The host supplies the
Linux kernel, compatible glibc, and CA trust roots. The manifest records the
maximum GLIBC symbol version used by the ELF files. This is a minimum ABI
requirement, not a promise about every distribution. Optional outside programs
used by unrelated OMP CLI features are not application runtime dependencies.

An AppImage can run through FUSE, or be extracted without FUSE:

```sh
chmod +x zproxy-omp-linux-x64.AppImage
./zproxy-omp-linux-x64.AppImage --appimage-extract
./squashfs-root/AppRun --help
```

CI tests the actual extracted image. It imports the bundled official OMP
modules, starts the official CLI help, runs the ordinary proxy smoke, and runs
the split OMP and AG flows against isolated fake upstreams. These flows check
streaming before EOF, concurrent requests, remote credentials, public reports,
signature recovery, and clean worker shutdown. A successful image upload
requires all these checks to pass.
