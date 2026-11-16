# Linux AppImage

The normal `zproxy-linux-x64` artifact contains the small NativeAOT core. The
optional `zproxy-omp-linux-x64` artifact is a real AppImage containing that core,
Bun, OMP source, its production packages and native addon, and the non-glibc
shared-library closure. Pass `--omp` to activate the OMP plugin. Merely using
the larger AppImage does not start OMP.

## Build

Use Ubuntu 24.04 x86-64, Python 3.11 or newer, Git, and the .NET SDK selected by
`global.json`. Install `clang`, `libzstd-dev`, `zlib1g-dev`, `libssl-dev`, and
`desktop-file-utils`. Then run from the repository root:

```sh
python3 scripts/prepare-omp.py
plugins/omp/bin/bun run --cwd plugins/omp test
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 --self-contained true -p:PublishAot=true \
  --output artifacts/linux-x64
python3 scripts/smoke-native.py --binary artifacts/linux-x64/ZProxy
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy --omp-dir plugins/omp
python3 scripts/build-appimage.py --binary artifacts/linux-x64/ZProxy
python3 scripts/smoke-appimage.py --image artifacts/zproxy-omp-linux-x64.AppImage
```

`prepare-omp.py` accepts `--source PATH` for an existing checkout at the exact
pinned OMP commit, `--shims-source PATH` for the pinned original omp-shims
checkout, and `--bun PATH` for the exact pinned Bun version. The build
uses `upstream.lock.json` and the frozen `bun.lock`; installation scripts are
disabled. The original omp-shims snapshot has no runtime npm dependencies.
The OMP and omp-shims patches have before/after hash checks. A source
change must be reviewed and repinned before the patch can be applied.

The AppImage tool, its runtime, Bun, and their downloaded notices are verified
by SHA-256. The optional native OMP package is pinned by npm integrity in the
lock. Git verifies the fetched OMP commit. The build does not fetch a moving OMP
branch or run its package lifecycle scripts.

## Contents and use

The image includes these important paths:

| Path inside the image | Purpose |
| --- | --- |
| `usr/bin/ZProxy` | NativeAOT core |
| `usr/bin/bun` | Pinned baseline x86-64 Bun |
| `usr/lib/zproxy/omp` | Optional plugin and complete OMP runtime graph |
| `usr/lib/zproxy/lib` | zstd, OpenSSL, and non-glibc dependency closure |
| `usr/share/zproxy/bundle.json` | Source, lock, binary, library, and platform provenance |
| `usr/share/licenses/zproxy-omp` | Runtime notices; npm notices also remain in their packages |

For a client, use the same client arguments as the small core and add `--omp`.
Only the server takes `--omp-config`. A server configuration and its credential
database are runtime inputs; neither is copied into the AppImage. `AppRun`
sets the bundled OMP and Bun paths and then passes every argument to the core.
The normal `ZPROXY_OMP_DIR`, `ZPROXY_BUN`, `--omp-dir`, and `--bun` overrides
remain available.

No host Bun or .NET installation is needed at runtime. The host supplies the
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
the split OMP flow against an isolated fake upstream. The flow checks streaming
before EOF, concurrent requests, remote credentials, public reports, and clean
worker shutdown. A successful image upload requires all these checks to pass.
