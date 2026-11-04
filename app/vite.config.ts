import fs from "node:fs"
import path from "path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, searchForWorkspaceRoot } from "vite"

const repoRoot = path.resolve(__dirname, "..")
// node_modules 是软链(本地盘缓存),字体等资源真实路径在缓存目录——按真实路径放行
const realNodeModules = fs.realpathSync(path.resolve(__dirname, "node_modules"))

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), react()],
  server: {
    // 契约 §7:board dev 用 5173(core CORS 白名单含 localhost:5173)
    port: 5173,
    // 5173 被占时 fail-loud 退出,不静默换端口——换了端口 live 模式会被 core CORS 拒
    strictPort: true,
    fs: {
      // fixture JSONL 在仓库 fixtures/ 下;字体在软链 node_modules 的真实目录下
      allow: [searchForWorkspaceRoot(__dirname), repoRoot, realNodeModules],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
