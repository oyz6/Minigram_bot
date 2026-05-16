# Turnstile 验证 + Telegram 私聊转发 Bot 部署文档

## 所需变量速查

| 环境变量 | 所属 Worker | 示例值 | 说明 |
|----------|-------------|--------|------|
| `CAPTCHA_SECRET_KEY` | 验证页面 Worker | `0x3...FF` | Cloudflare Turnstile 后端密钥 |
| `CAPTCHA_SITE_KEY` | 验证页面 Worker | `3x0...FF` | Cloudflare Turnstile 前端密钥 |
| `VERIFY_SECRET` | 两个 Worker 共用 | `u0zcgbzN4vYJpEmzs0yR` | HMAC 签名密钥（必须一致） |
| `BOT_TOKEN_ENV` | 主 Bot Worker | `123456:ABC...` | Telegram Bot Token |
| `GROUP_ID_ENV` | 主 Bot Worker | `-1001234567890` | 接收消息的群组 ID |
| `MAX_MESSAGES_PER_MINUTE_ENV` | 主 Bot Worker | `40` | 每分钟消息速率限制 |
| `VERIFY_URL` | 主 Bot Worker | `https://verify.example.com` | 验证页面的完整 URL |
| `VERIFY_SECRET` | 主 Bot Worker | 同上 | 与验证页面 Worker 相同 |
| `D1` | 主 Bot Worker (绑定) | - | D1 数据库绑定名称 |

> **注意**：`VERIFY_SECRET` 在两个 Worker 中必须完全一致，否则签名验证失败。

---

## 部署步骤

### 1. 获取凭据与生成密钥

- **Bot Token**：在 [@BotFather](https://t.me/BotFather) 创建 Bot 获取。
- **群组 ID**：将 Bot 加入**开启了话题模式**的超级群组并设为管理员，通过 [@getidsbot](https://t.me/getidsbot) 获取（格式：`-100xxxxxxxxxx`）。
- **Turnstile 密钥**：在 Cloudflare 控制台 → Turnstile 添加站点，获得 Site Key 和 Secret Key。
- **HMAC 密钥**：终端运行 `openssl rand -base64 15`，或自定义一个字符串，作为 `VERIFY_SECRET`。

### 2. 部署验证页面 Worker（`captcha.js`）

1. 在 Cloudflare Workers 中创建新 Worker。
2. 粘贴 [修改后的 `captcha.js` 代码](#验证页面-worker-完整代码)（变量已全大写）。
3. 在 Worker 设置 → **Variables** 中添加：
   - `CAPTCHA_SECRET_KEY` → Turnstile 后端密钥
   - `CAPTCHA_SITE_KEY` → Turnstile 前端密钥
   - `VERIFY_SECRET` → 步骤 1 的 HMAC 密钥
4. 部署，记住 Worker 域名（例如 `verify.example.com`），这就是 `VERIFY_URL`。

### 3. 部署主 Bot Worker

1. 创建另一个 Worker，粘贴**主 Bot 整合代码**（上一轮已提供的完整代码）。
2. 绑定 D1 数据库：
   - 在 Cloudflare 控制台创建 D1 数据库。
   - 在 Worker 设置 → **D1 数据库绑定** 中，添加绑定，变量名设为 `D1`，选择你创建的数据库。
3. 在 Worker 设置 → **Variables** 中添加：
   - `BOT_TOKEN_ENV` → Bot Token
   - `GROUP_ID_ENV` → 群组 ID
   - `MAX_MESSAGES_PER_MINUTE_ENV` → 速率限制（如 `40`）
   - `VERIFY_URL` → 验证页面 Worker 的完整 URL（如 `https://verify.example.com`）
   - `VERIFY_SECRET` → 与步骤 2 完全相同的 HMAC 密钥
4. 部署 Worker。

### 4. 初始化数据库并注册 Webhook

1. 访问 `https://你的主Bot域名/checkTables`，返回 `Database tables checked and repaired` 即成功。
2. 访问 `https://你的主Bot域名/registerWebhook`，返回 `Webhook set successfully` 完成。

### 5. 使用

- **用户侧**：私聊 Bot 发送 `/start` → 点击验证链接 → 完成 Turnstile → 复制 `/checkin ...` 命令发给 Bot → 验证通过，即可正常聊天。
- **管理侧**：在群组任意用户话题内发送 `/admin` 调出管理面板（拉黑/解封、开关验证、查看黑名单、删除用户等）。
- **重置用户**：在话题内发送 `/reset_user <chat_id>`（管理员可用）。

---

## 注意事项

- 群组必须开启**话题模式**，否则无法自动创建用户话题。
- 验证有效期默认 **24 小时**，过期后需重新验证。
- 关闭验证功能（通过管理面板）后，所有用户直接放行。
- D1 数据库表结构会自动创建，无需手动建表。
- 所有变量名均已大写，与 Worker 环境变量严格一致。

---
