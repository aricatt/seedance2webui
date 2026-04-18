# SMTP 邮箱服务配置指南

本文档介绍如何在 Seedance 2.0 项目中配置 SMTP 邮箱服务，用于用户注册时发送验证码。

## 一、配置方式

有两种方式可以配置 SMTP 参数：

### 方式一：通过环境变量配置（推荐开发环境）

1. 复制 `.env.example` 为 `.env`
2. 编辑 `.env` 文件，取消注释并填写 SMTP 配置：

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_email@qq.com
SMTP_PASS=your_smtp_authorization_code
SMTP_FROM=your_email@qq.com
SMTP_FROM_NAME=Seedance 2.0
SMTP_TLS_REJECT_UNAUTHORIZED=true
```

3. 重启后端服务

### 方式二：通过管理后台配置（推荐生产环境）

1. 使用管理员账号登录系统
2. 进入「管理后台」页面
3. 找到「系统设置」或「SMTP 配置」部分
4. 填写 SMTP 参数并保存
5. 配置实时生效，无需重启服务

## 二、常见邮箱 SMTP 配置

### QQ 邮箱

| 配置项 | 值 |
|--------|-----|
| SMTP_HOST | smtp.qq.com |
| SMTP_PORT | 465 |
| SMTP_SECURE | true |
| SMTP_USER | 你的 QQ 邮箱 |
| SMTP_PASS | 授权码（不是 QQ 密码） |

**获取授权码步骤：**
1. 登录 QQ 邮箱网页版
2. 进入「设置」→「账户」
3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」
4. 开启「IMAP/SMTP 服务」
5. 点击「生成授权码」
6. 按提示发送短信验证后获取授权码

### 163 邮箱

| 配置项 | 值 |
|--------|-----|
| SMTP_HOST | smtp.163.com |
| SMTP_PORT | 465 |
| SMTP_SECURE | true |
| SMTP_USER | 你的 163 邮箱 |
| SMTP_PASS | 授权码（不是网易密码） |

**获取授权码步骤：**
1. 登录 163 邮箱网页版
2. 进入「设置」→「POP3/SMTP/IMAP」
3. 开启「IMAP/SMTP 服务」
4. 点击「客户端授权密码」→「设置」
5. 获取授权码

### Gmail

| 配置项 | 值 |
|--------|-----|
| SMTP_HOST | smtp.gmail.com |
| SMTP_PORT | 587 |
| SMTP_SECURE | false |
| SMTP_USER | 你的 Gmail 地址 |
| SMTP_PASS | 应用专用密码 |

**注意事项：**
- Gmail 需要开启两步验证
- 需要生成应用专用密码（App Password）
- 如果使用 SMTP_SECURE=true，端口改为 465

## 三、配置参数说明

| 参数名 | 说明 | 示例 |
|--------|------|------|
| `SMTP_HOST` | SMTP 服务器地址 | smtp.qq.com |
| `SMTP_PORT` | SMTP 端口号 | 465 或 587 |
| `SMTP_SECURE` | 是否启用 SSL | true/false |
| `SMTP_USER` | SMTP 用户名（通常是邮箱） | example@qq.com |
| `SMTP_PASS` | SMTP 密码/授权码 | abcdefghijklmnop |
| `SMTP_FROM` | 发件人邮箱 | example@qq.com |
| `SMTP_FROM_NAME` | 发件人名称 | Seedance 2.0 |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | TLS 证书校验 | true/false |

## 四、验证配置

配置完成后，可以通过以下方式验证：

1. **开发环境测试**：
   - 访问注册页面
   - 输入测试邮箱
   - 点击「获取验证码」
   - 查看控制台日志（开发模式下会输出质码）

2. **生产环境测试**：
   - 访问注册页面
   - 输入真实邮箱
   - 点击「获取验证码」
   - 检查邮箱是否收到验证码

## 五、常见问题

### 1. 发送失败，提示「认证失败」

- 检查 SMTP_USER 和 SMTP_PASS 是否正确
- QQ 邮箱和 163 邮箱需要使用授权码，不是登录密码
- 确认授权码没有过期

### 2. 连接超时

- 检查 SMTP_HOST 和 SMTP_PORT 是否正确
- 确认服务器防火墙允许出站连接
- 某些云服务商可能屏蔽了 SMTP 端口

### 3. 证书校验失败

- 如果遇到 TLS 证书错误，可将 `SMTP_TLS_REJECT_UNAUTHORIZED` 设置为 `false`
- 注意：生产环境不建议关闭证书校验

### 4. 验证码收到但无法验证

- 检查验证码有效期（默认 10 分钟）
- 确认输入的验证码没有多余空格
- 查看数据库 `email_verification_codes` 表确认记录

## 六、安全建议

1. **不要将 `.env` 文件提交到代码仓库**
   - 已添加到 `.gitignore`
   - 使用 `.env.example` 作为模板

2. **定期更换授权码**
   - 建议每 3-6 个月更换一次

3. **限制发送频率**
   - 系统已实现防刷机制
   - 同一邮箱 1 小时内最多发送 5 次
   - 同一 IP 1 小时内最多发送 20 次

4. **使用 HTTPS**
   - 生产环境建议使用 HTTPS
   - 防止验证码在传输过程中被窃取

## 七、技术支持

如遇问题，请联系：
- 微信：laohaibao2025
- 邮箱：75271002@qq.com
