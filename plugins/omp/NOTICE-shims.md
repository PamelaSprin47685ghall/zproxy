# Third-party notices for the bundled routing layer

`plugins/omp/router`, `plugins/omp/shim`, and `plugins/omp/presets` are
maintained in this repository. They began as a snapshot of the MIT-licensed
`omp-shims` project (upstream commit
`34189f420516f5ceeb8373998cc31896553c57ea`, version 2.0.0, "Copyright (c) 2026
omp-shims contributors") and have been reorganised and edited here since.

The routing engine in `router/` and the host bridge in `shim/` are therefore
distributed under the MIT terms of that upstream project. Everything else in
this directory remains under the repository's own license.

`shim/vendor/earendil-works-pi-ai` and `shim/vendor/earendil-works-pi-coding-agent`
are small MIT-licensed compatibility packages that the plugin bridge registers
as `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` for third-party
OMP plugins.
