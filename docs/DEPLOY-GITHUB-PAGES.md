# GitHub Pages 部署方案（bingshuoguo.github.io）

## 1. 目标与约束

| 项目 | 说明 |
|------|------|
| **公网域名** | `https://bingshuoguo.github.io`（GitHub **User Pages**，与个人账号绑定） |
| **仓库命名** | 必须为 **`bingshuoguo/bingshuoguo.github.io`**（`用户名.github.io`，全小写） |
| **站点根路径** | 根路径 `/`，**不要**设置 Astro `base`（与 project pages 的 `/repo-name/` 不同） |
| **产物** | Astro 静态站点 → `npm run build` → `dist/` |

## 2. 架构概览

```
本地/PR ── push main ──► GitHub: bingshuoguo.github.io
                              │
                              ▼
                    GitHub Actions (deploy.yml)
                    npm ci → npm run build → dist/
                              │
                              ▼
                    GitHub Pages (artifact 部署)
                              │
                              ▼
                    https://bingshuoguo.github.io
```

- **构建**：Ubuntu + Node 22 + `npm ci`，与 `package.json` 的 `engines.node` 一致。
- **发布**：使用官方 `upload-pages-artifact` + `deploy-pages`，无需 `gh-pages` 分支或 `docs/` 目录。

## 3. 仓库与首次上传

1. 在 GitHub 新建仓库：**Repository name** 填 `bingshuoguo.github.io`，**Public**，**不要**勾选「Initialize with README」（若本地已有代码）。
2. 本地（在 PersonWeb 目录）：

   ```bash
   git remote add origin https://github.com/bingshuoguo/bingshuoguo.github.io.git
   git add .
   git commit -m "chore: initial site + GitHub Pages workflow"
   git branch -M main
   git push -u origin main
   ```

   若远程已存在且名称不同，可用 `git remote set-url origin ...`。

## 4. 启用 GitHub Pages

1. 打开仓库 **Settings → Pages**。
2. **Build and deployment → Source**：选择 **GitHub Actions**（不要选 Deploy from a branch，除非改用传统方式）。
3. 首次 `main` 推送后，**Actions** 里应出现 **Deploy to GitHub Pages** 工作流；成功后面板会显示站点 URL。

生效时间：通常 **1～3 分钟**；HTTPS 由 GitHub 托管证书。

## 5. Astro 配置要点

- **`site`**（已在 `astro.config.mjs`）：`https://bingshuoguo.github.io`  
  用于 canonical、sitemap、RSS 等绝对 URL；用户站点**无需** `base`。
- 若将来改用 **Project Pages**（仓库名如 `PersonWeb`，地址为 `https://bingshuoguo.github.io/PersonWeb/`），才需要设置 `base: '/PersonWeb'` 并同步调整 `site`。

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| 404 | 确认仓库名是否为 `用户名.github.io`；Actions 是否成功；Pages 源是否为 GitHub Actions。 |
| 样式/资源路径错误 | 用户站点一般无此问题；若用了子路径需检查 `base`。 |
| 构建失败 | 本地执行 `npm ci && npm run build` 复现；检查 Node 版本。 |
| 自定义域名 | **Settings → Pages → Custom domain** 配置 DNS；本项目未包含 CNAME，按需添加。 |

## 7. 可选后续

- **预览 PR**：可增加 workflow `on: pull_request` 仅用 `npm run build` 校验，不部署。
- **RSS / sitemap**：`site` 已就绪，可按 Astro 文档加 `@astrojs/rss` 与 sitemap 集成。
