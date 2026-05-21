# wx-proxy

微信公众号 API 中转代理服务 —— 解决家庭动态 IP 无法加入微信白名单的问题。

## 问题

微信公众号后台要求 API 调用方的 IP 加入白名单才能获取 `access_token` 并调用业务接口。

中国大多数家庭宽带没有固定公网 IPv4，IP 会轮换，无法加入白名单。

## 方案

在固定 IP 的云服务器上部署此代理，家庭服务器通过 HTTP 调用代理间接访问微信 API。

```
家庭服务器(动态IP)  ──HTTP + X-Api-Key──▶  云服务器(固定IP)  ──HTTPS──▶  微信公众平台
  wx-proxy 客户端                         wx-proxy 服务器              IP 白名单放云服务器
```

## 部署（云服务器端）

```bash
git clone <repo> && cd wx-proxy
npm install
cp .env.example .env
nano .env          # 填入微信公众号 APP_ID / APP_SECRET / API_KEY

# 测试运行
node server.js

# 生产运行（推荐 pm2）
npm install -g pm2
pm2 start server.js --name wx-proxy
pm2 save && pm2 startup
```

**配置 .env:**

```ini
WX_APP_ID=wx_your_app_id
WX_APP_SECRET=your_secret
PORT=3900
API_KEY=这里填一个随机字符串    # openssl rand -hex 32
# 可选：
RATE_LIMIT_RPM=60              # 每分钟限制 60 次请求
TOKEN_CACHE_FILE=/tmp/wx-proxy-token.json  # 持久化 token，重启不浪费
```

**微信公众号后台:**
设置与开发 → 基本配置 → IP 白名单 → 加入云服务器的公网 IP。

**验证:**

```bash
# 在服务器上
curl http://localhost:3900/health

# 从家庭服务器测试
curl -H "X-Api-Key: $API_KEY" http://<云服务器IP>:3900/api/token
```

## 使用（家庭服务器端）

### 作为 CLI

```bash
# 配置环境变量
export WX_PROXY_URL=http://43.142.162.14:3900
export WX_PROXY_KEY=你的API密钥

# 健康检查
node client.js health

# 新建草稿
node client.js draft:add '{"articles":[{"title":"测试","content":"<p>正文</p>","thumb_media_id":"","digest":"摘要"}]}'

# 查看草稿列表
node client.js draft:list

# 上传图片
node client.js media:uploadimage '{"image_url":"https://example.com/pic.png"}'

# 发布
node client.js publish:submit '你的草稿media_id'
```

### 作为 Node.js 库

```javascript
const WxClient = require('./client');
const wx = WxClient.create({
  serverUrl: 'http://43.142.162.14:3900',
  apiKey: '你的API密钥',
});

// 健康检查
const health = await wx.health();

// 上传封面图
const thumb = await wx.media.uploadThumb('https://example.com/cover.jpg');

// 上传正文图片
const img = await wx.media.uploadImage('https://example.com/body.png');

// 创建草稿
const draft = await wx.draft.add({
  articles: [{
    title: '文章标题',
    content: '<p>HTML 正文，图片用 <img src="https://mmbiz.qpic.cn/xxx" /></p>',
    thumb_media_id: thumb.media_id,
    author: '作者',
    digest: '摘要',
  }]
});

// 发布草稿
await wx.publish.submit(draft.media_id);

// 一键发布（自动处理图片上传）
const result = await wx.publishArticleAuto({
  title: '文章标题',
  content: '<p>包含 <img src="https://a.com/1.png" /> 的文章</p>',
  thumbUrl: 'https://a.com/cover.jpg',
});
```

## API 接口

所有 `/api/*` 路由需要 `X-Api-Key` 请求头。

### 草稿

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/draft/add` | 新建草稿 |
| GET  | `/api/draft/list` | 草稿列表 (?offset&count) |
| GET  | `/api/draft/:mediaId`| 草稿详情 |
| POST | `/api/draft/update` | 更新草稿 |
| POST | `/api/draft/delete` | 删除草稿 |

### 发布

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/publish/submit` | 发布 |
| POST | `/api/publish/status` | 查询发布状态 |
| POST | `/api/publish/delete` | 删除已发布 |

### 素材

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/media/uploadthumb` | 上传封面图（通过 URL） |
| POST | `/api/media/uploadimage` | 上传正文图片（通过 URL） |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/health` | 健康检查（无需认证） |
| GET  | `/api/token` | 查看 access_token |
| POST | `/api/proxy` | 通用转发（任意微信 API） |

## 对比原始项目 (MAPLEYOU/wechat-proxy)

| 特性 | 原项目 | wx-proxy |
|------|--------|----------|
| 配置方式 | config.js 硬编码 | .env 环境变量 |
| 日志格式 | console.log 自由格式 | 结构化 JSON 日志 |
| 速率限制 | 无 | express-rate-limit，可选 |
| Token 持久化 | 无（重启丢失） | 可选磁盘持久化 |
| 客户端 SDK | 无 | 完整 SDK + CLI |
| 通用转发安全性 | 无校验 | path 注入防护 |
| 错误处理 | 返回 Axios 错误 | 统一错误格式 |
| 一键发布 | 无 | publishArticle / publishArticleAuto |
| 草稿更新 | 无 | POST /api/draft/update |
| 草稿详情 | 无 | GET /api/draft/:mediaId |
| 发布删除 | 无 | POST /api/publish/delete |

## 安全建议

1. **启用 HTTPS**：在生产环境用 Nginx 反向代理并开启 SSL
2. **防火墙**：仅对家庭网络的出口 IP 开放端口（如果出口 IP 相对固定的话）
3. **使用强 API_KEY**：32 位以上随机字符串
4. **定期轮换** API_KEY 和 AppSecret

## License

MIT
