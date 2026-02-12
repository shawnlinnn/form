# Google Form Chat Generator

一个对话式网站：用户描述需求，系统自动创建 Google Form。

## 1. 准备 Google OAuth

1. 打开 Google Cloud Console，创建项目。
2. 启用 API：Google Forms API。
3. 配置 OAuth consent screen。
4. 创建 OAuth Client ID（Web Application）。
5. 在 Authorized redirect URI 添加：
   - `http://localhost:3000/auth/google/callback`
   - `https://你的线上域名/auth/google/callback`

## 2. 配置环境变量

```bash
cp .env.example .env
```

填写 `.env`：

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `OPENAI_API_KEY`（用于 LLM 生成题目）
- `OPENAI_MODEL`（可选，默认 `gpt-4.1-mini`）
- `OPENAI_PROXY`（可选，例如 Clash: `http://127.0.0.1:7890`）
- `GOOGLE_API_PROXY`（可选，例如 Clash: `http://127.0.0.1:7890`）

## 3. 启动

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 3.1 发布到 Render（推荐）

1. 把项目推到 GitHub。
2. 打开 Render，选择 `New +` -> `Blueprint`，选择你的仓库（仓库里已包含 `render.yaml`）。
3. 在 Render 环境变量里确认：
   - `BASE_URL=https://你的render域名`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `OPENAI_API_KEY`
4. 回到 Google Cloud，把回调地址加上：
   - `https://你的render域名/auth/google/callback`
5. 部署完成后访问站点并测试登录。

## 4. 功能

- 对话输入需求
- 支持上传本地文件（`.csv` / `.json` / `.txt` / `.md` / `.tsv` / `.pdf`）生成表单
- LLM 优先生成结构化表单草稿（失败时自动回退规则模式）
- 未登录时引导 Google 登录
- 登录后自动申请 `forms.body` 权限
- 根据对话内容自动生成 Google Form 与问题草稿
- 返回编辑链接和填写链接

## 5. 说明

当前已支持文本题、段落题、单选题与部分必填规则。  
如果上传 CSV/JSON，会优先按字段自动生成题目；可再配合一句补充描述来调整语气和用途。
