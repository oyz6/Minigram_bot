# Turnstile 验证 + Telegram 私聊 Bot + 话题模式

## 所需变量速查

| 环境变量 | 所属 Worker | 示例值 | 说明 |
|----------|-------------|--------|------|
| `CAPTCHA_SECRET_KEY` | 验证页面 Worker | `0x3...FF` | Cloudflare Turnstile 后端密钥 |
| `CAPTCHA_SITE_KEY` | 验证页面 Worker | `3x0...FF` | Cloudflare Turnstile 前端密钥 |
| `BOT_USERNAME` | 验证页面 Worker | `my_cool_bot` | Bot 用户名 不带 @ |
| `VERIFY_SECRET` | 注意:两个 Worker 共用 | `u0zcgbzN4vYJpEmzs0yR` | HMAC 签名密钥（必须一致） |
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
2. 粘贴最新的 [`captcha.js` 代码](#验证页面-worker-完整代码)（变量已全大写）。
3. 在 Worker 设置 → **Variables** 中添加：
   - `CAPTCHA_SECRET_KEY` → Turnstile 后端密钥
   - `CAPTCHA_SITE_KEY` → Turnstile 前端密钥
   - `VERIFY_SECRET` → 步骤 1 的 HMAC 密钥
4. 部署，记住 Worker 域名（例如 `verify.example.com`），这就是 `VERIFY_URL`。

### 3. 部署主 Bot Worker

1. 创建另一个 Worker，粘贴最新的**主 Bot 整合代码**（`tg_worker.js`）。
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

> **提示**：主 Bot Worker 在首次收到请求时会自动检查表结构并注册 Webhook，上述步骤为手动确认方式，你可根据需要执行。

### 5. 使用

- **用户侧**：
  1. 私聊 Bot 发送任意消息（或 `/start`），Bot 会发送验证链接。
  2. 点击按钮打开验证页面，完成 Turnstile 人机验证。
     - 如果在 **Telegram 内置浏览器**中打开，验证成功后验证码会**自动发送给 Bot**，无需额外操作。
     - 如果在普通浏览器中打开，验证成功后会显示 `/checkin ...` 命令，复制并发送给 Bot 即可完成验证。
  3. 验证通过后即可正常聊天，所有私聊消息将转发至群组中的专属话题。

- **管理侧**：在群组任意用户话题内发送 `/admin` 调出管理面板（拉黑/解封、开关验证、查看黑名单、删除用户等）。
- **重置用户**：在话题内发送 `/reset_user <chat_id>`（管理员可用）。

---

## 注意事项

- 群组必须开启**话题模式**，否则无法自动创建用户话题。
- 验证有效期默认 **24 小时**，过期后需重新验证。验证码本身有效期为 **5 分钟**。
- 关闭验证功能（通过管理面板）后，所有用户直接放行。
- D1 数据库表结构会在首次请求或手动访问 `/checkTables` 时自动创建，无需手动建表。
- 所有变量名均已大写，与 Worker 环境变量严格一致。
- 若用户在 Telegram 内直接点击验证按钮完成 Turnstile，验证码将通过 Web App `sendData` 自动回传，体验更流畅；若自动发送失败，界面会提供手动发送按钮作为备用。

## 原作者

- https://github.com/oldfriendme/Minigram
- https://github.com/iawooo/ctt

## 原教程

- 如需获取简单版本配置教程，可访问 [Simple.md](simple.md) 文件
- 如需图文教程版本配置教程，可访问 [Full.md](full.md) 文件
