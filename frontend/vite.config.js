import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The build output is an embedded resource of the NativeAOT binary. It is
// committed so a plain `dotnet publish` needs neither Bun nor Node.
export default defineConfig({
  base: '/assets/',
  plugins: [svelte()],
  build: {
    outDir: '../src/ZProxy/StatusAssets',
    emptyOutDir: true,
    manifest: 'manifest.json',
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: { input: 'src/main.js' },
  },
})
