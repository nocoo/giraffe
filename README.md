<p align="center"><img src="logo.png" width="128" height="128"/></p>

<h1 align="center">Giraffe</h1>

<p align="center"><strong>个人 GitHub 监控控制台</strong><br>加密 PAT · D1 快照 · Basalt SPA</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-7-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Cloudflare_Workers-Hono-orange" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/UI-Basalt_2.0.2-black" alt="Basalt" />
</p>

---

## 这是什么

Giraffe 用 GitHub classic PAT 在 Cloudflare Worker 侧拉取数据，加密后写入 D1 快照，再给 Vite SPA 展示。明文 PAT 只出现在设置页输入、当次请求体、Worker 内存解密结果和出站 `Authorization` 头。门禁是 Cloudflare Access，应用内没有登录页。

生产：https://giraffe.hexly.ai  
开发：https://giraffe.dev.hexly.ai

## 功能

- **多账号 PAT** — AES-GCM 信封存 D1，可切换、删除
- **仓库 / Issue / PR** — 列表、网格、单仓钻取
- **Insights / 告警 / 通知 / 日报** — 只读快照；回源走 `POST /api/refresh`
- **侧栏身份** — Access 邮箱 + lizheng.blog 头像

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers + Hono |
| 数据 | D1 `giraffe-db` |
| 前端 | Vite 8 + React 19 + `@nocoo/basalt` |
| 测试 | Vitest L1、HTTP L2、Playwright L3 |

## 开发

```bash
bun run dev          # Vite :7045 + wrangler :7046
bun run typecheck
bun run lint
bun run test
bun run test:coverage
bun run test:e2e:api
```

源 logo 是根目录 `logo.png`。派生图标：

```bash
./scripts/resize-logos.sh
```

生成 `public/logo-24.png`（侧栏）、`public/logo-32.png`（favicon）、`public/apple-touch-icon.png`。

## 文档

- [01 架构](docs/01-architecture.md)
- [02 质量](docs/02-quality.md)
- [03 Schema](docs/03-schema.md)
- [04 Server](docs/04-server.md)
- [05 Client](docs/05-client.md)
