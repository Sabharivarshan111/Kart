import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The brief's hard rule is zero external assets: everything is generated in
// code, so the whole game is expected to inline into one HTML document that
// plays from file://. viteSingleFile is what folds the JS/CSS back in.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    // 4 MiB: well above what we ship, but the inline limit has to exceed the
    // bundle or the plugin silently leaves an external chunk behind.
    assetsInlineLimit: 4 * 1024 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
