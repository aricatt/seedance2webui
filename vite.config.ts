import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const configDir = path.dirname(fileURLToPath(import.meta.url));

/** 与 Express `.env` 中 `PORT` 对齐（从 vite.config 所在目录读 .env，避免 cwd 不对时代理连错端口） */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, configDir, '');
  const apiPort = (env.PORT || '3901').trim();

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
