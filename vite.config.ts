import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  // 相对路径：部署到任意子路径（如 GitHub Pages）资源都能正确加载
  base: './',
  plugins: [react()],
  server: {
    // 固定端口：方便在多维表格中注册自定义插件服务地址
    port: 9000,
    strictPort: true,
  },
});
