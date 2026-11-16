# Runtime contents and source

This AppImage includes the zproxy NativeAOT program, Bun, the pinned Oh My Pi
source, its production JavaScript dependencies, its Linux x86-64 native addon,
the optional static AG2API codec worker, and the non-glibc shared libraries used
by these components. OMP support remains optional: pass `--omp` to use it.
AG2API support must also be enabled in the remote configuration. No upstream
account or credential is included.

The build records source revisions, download hashes, the npm lock hash, library
package versions, and the required glibc version in
`usr/share/zproxy/bundle.json`. The same manifest is published beside the image.
The bundled OMP package sources are in `usr/lib/zproxy/omp/vendor/omp`; the checked zproxy
patch is `usr/lib/zproxy/omp/patch-upstream.mjs`. JavaScript package licenses and
native third-party notices remain in their original package directories.
The pinned original omp-shims source is in `usr/lib/zproxy/omp/vendor/shims`.
Its independent routing primitives are reused by the optional remote policy.
Its checked raw-response patch is `usr/lib/zproxy/omp/patch-shims.mjs`.
The AG2API worker is built from the pinned module plus additive zproxy codec
files. The source repository and exact revision are in the build record.
It does not start the AG2API application, account store, login flow, updater,
or account balancer.
The build record includes the Go toolchain pin, overlay hashes, worker hash,
and the actual Go module versions. Their licenses and the Go notices are in
the `ag2api` subdirectory. The image does not include the AG2API source build
tree, a Go compiler, or a Go module cache.

OMP source: https://github.com/can1357/oh-my-pi

omp-shims source: https://github.com/PamelaSprin47685ghall/omp-shims

AG2API source: https://github.com/Mag1cFall/Antigravity2API

Go source: https://go.googlesource.com/go

Bun source and JavaScriptCore notices: https://github.com/oven-sh/bun

.NET source: https://github.com/dotnet/runtime

AppImage runtime source: https://github.com/AppImage/type2-runtime

The `dotnet`, `system`, Bun, OMP, and AppImage license files are included in this
directory. The distribution package and source package versions for each copied
system library are in the manifest. Their corresponding sources are available
from the Ubuntu package archive at https://archive.ubuntu.com/ubuntu/pool/ for
the official CI build. The build does not copy a host .NET SDK, npm cache,
credential store, or user configuration into the image.

The host provides the Linux kernel, glibc, standard system configuration and CA
trust roots. The minimum glibc version is measured from the bundled ELF files;
it is not a claim of compatibility with every Linux distribution. Optional OMP
CLI features that invoke outside programs still require those programs.
