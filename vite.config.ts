import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: 'src/background.ts',
        content: 'src/content/index.tsx',
        pageHook: 'src/pageHook.ts'
      },
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
});
