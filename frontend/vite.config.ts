import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.FLYBRAIN_API_URL ?? 'http://127.0.0.1:8771';
const streamTarget = process.env.FLYBRAIN_STREAM_URL ?? 'ws://127.0.0.1:8765';
const proxy = {
  '/health': { target: apiTarget, changeOrigin: false },
  '/v1': { target: apiTarget, changeOrigin: false },
  '/stream': { target: streamTarget, ws: true, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
