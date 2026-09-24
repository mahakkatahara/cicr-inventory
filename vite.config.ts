import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lucide')) {
              return 'vendor-icons';
            }
            if (id.includes('three')) {
              return 'vendor-three';
            }
            return 'vendor';
          }
        }
      }
    }
  }
});
