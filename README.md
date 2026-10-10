# 树洞 · Netlify 部署包

这是一个可直接部署到 Netlify 的完整版本，保留账号注册登录、心事发布、图片、回音、Emoji 反应、私聊、拉黑、举报、宠物系统和每日心情记录等功能。

## 目录结构

```text
treehole-netlify/
├─ netlify.toml
├─ package.json
├─ public/                    # 前端页面、样式、脚本和图标
└─ netlify/functions/api/     # Netlify Function API 与树洞服务端核心
```

前端通过 `/api/*` 访问 Netlify Function。生产数据使用 **Netlify Blobs** 持久化，不需要 PostgreSQL，也不需要把本地 `data/` 目录上传到线上。

## 方式一：在 Netlify 后台连接 Git

1. 把 `treehole-netlify` 文件夹内的全部内容上传到 GitHub / GitLab / Bitbucket 仓库。
2. 在 Netlify 选择 **Add new site → Import an existing project**。
3. 连接仓库后使用以下配置：

- Build command：`npm run check`
- Publish directory：`public`
- Functions directory：`netlify/functions`

仓库根目录已经包含 `netlify.toml`，Netlify 会自动识别发布目录、函数目录和路由配置。

## 方式二：使用 Netlify CLI

```bash
cd treehole-netlify
npm install -g netlify-cli
netlify login
netlify link
netlify deploy --prod
```

如果站点尚未创建，可以先执行：

```bash
netlify sites:create
```

## 必须配置的环境变量

在 Netlify 的 **Site configuration → Environment variables** 中添加：

```text
TREEHOLE_BLOB_STORE=treehole
REQUIRE_LOGIN=1
TZ=Asia/Shanghai
DEFAULT_TIME_ZONE=Asia/Shanghai

ADMIN_TOKEN=请换成新的随机 Owner 令牌
ADMIN_MODERATOR_TOKEN=请换成新的随机 Moderator 令牌
ADMIN_READONLY_TOKEN=请换成新的随机 Readonly 令牌
```

三个管理令牌必须使用不同的随机值，不要继续使用示例或本地开发值。管理员入口仍然通过 `/admin` 访问。

常用可选配置：

```text
IMAGE_REVIEW=0
IMAGE_MAX_BYTES=4194304
ENABLE_HSTS=0
```

自定义 HTTPS 域名确认正常后，可以把 `ENABLE_HSTS` 改成 `1`。

## 实时消息说明

Netlify Functions 不适合维持长期 WebSocket/SSE 连接，因此此部署包会自动使用静默轮询：

- 心事和评论：约 30 秒刷新一次
- 聊天与通知：收到新消息后快速刷新
- 未读通知：页面空闲时定期刷新

功能和数据不会丢失，只是实时性从“即时推送”变为“短轮询”。数据量明显增长后，再迁移到云服务器 + PostgreSQL + WebSocket。

## 数据与安全

- 不要上传本地 `data/store.json`、`data/uploads`、`admin-token.txt`、`.env` 或 `node_modules`。
- Netlify Blobs 中的数据与本地 `data/` 相互独立，本地已有账号、心事、聊天和宠物不会自动迁移到线上。
- 图片上传上限默认是 4 MB，可通过 `IMAGE_MAX_BYTES` 调整。
- `REQUIRE_LOGIN=1` 会要求用户先登录，才能使用树洞、聊天和宠物功能。
- Netlify Function 的请求体、执行时间和并发数受套餐限制，图片与批量数据不要设置得过大。

## 部署后检查

1. 打开首页，确认能看到登录注册界面。
2. 注册账号，发布一条带图片的心事。
3. 用另一个账号回复、添加 Emoji 反应并发起私聊。
4. 打开 `/admin`，分别验证三个管理令牌。
5. 确认宠物可以互动、保存状态，刷新页面后数据仍在。
6. 连接自定义域名并确认 HTTPS 正常后，再开启 HSTS。

## 本地预览前端

该文件夹只用于 Netlify 部署，不含本地 Node HTTP 服务器。需要本地开发时，请使用项目根目录的 `server.js`。
