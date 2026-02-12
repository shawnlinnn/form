require('dotenv').config();

const path = require('path');
const https = require('https');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const { PDFParse } = require('pdf-parse');
const { recognize } = require('tesseract.js');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE
  ? process.env.SESSION_COOKIE_SECURE === 'true'
  : IS_PRODUCTION;
const SESSION_COOKIE_SAMESITE = process.env.SESSION_COOKIE_SAMESITE || 'lax';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const requiredEnv = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SESSION_SECRET'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

app.use(express.json());
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: SESSION_COOKIE_SECURE,
      sameSite: SESSION_COOKIE_SAMESITE,
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const googleStrategy = new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`
  },
  (accessToken, refreshToken, profile, done) => {
    return done(null, {
      id: profile.id,
      displayName: profile.displayName,
      email: profile.emails?.[0]?.value,
      avatar: profile.photos?.[0]?.value,
      accessToken,
      refreshToken
    });
  }
);

const oauthProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (oauthProxyUrl) {
  try {
    const oauthProxyAgent = new HttpsProxyAgent(oauthProxyUrl);
    googleStrategy._oauth2.setAgent(oauthProxyAgent);
    console.log(`Google OAuth token exchange using proxy: ${oauthProxyUrl}`);
  } catch (error) {
    console.error('Failed to configure OAuth proxy agent:', error.message);
  }
}

passport.use(googleStrategy);

function ensureAuth(req, res, next) {
  if (!req.isAuthenticated?.() || !req.user?.accessToken) {
    return res.status(401).json({
      error: 'not_authenticated',
      message: 'Please log in with Google first.'
    });
  }
  next();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  const code = error?.code || error?.cause?.code || '';
  const msg = String(error?.message || '');
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code) ||
    /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)/i.test(msg)
  );
}

async function withNetworkRetry(taskName, fn, maxAttempts = 3) {
  let lastErr;
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      if (!isRetryableNetworkError(error) || i === maxAttempts) {
        throw error;
      }
      const waitMs = 400 * i;
      console.error(`${taskName} failed (${error.message}), retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'form-chat-generator' });
});

app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/forms.body'
    ],
    accessType: 'offline',
    prompt: 'consent'
  })
);

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user) => {
    if (err) {
      const oauthData = err?.oauthError?.data ? String(err.oauthError.data) : '';
      const oauthStatus = err?.oauthError?.statusCode || '';
      console.error('Google OAuth callback failed:', {
        message: err.message,
        oauthStatus,
        oauthData
      });
      const reason = encodeURIComponent(oauthData || err.message || 'oauth_failed');
      return res.redirect(`/?auth=failed&reason=${reason}`);
    }

    if (!user) {
      return res.redirect('/?auth=failed&reason=no_user');
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('Google OAuth login session failed:', loginErr.message);
        return next(loginErr);
      }
      return res.redirect('/');
    });
  })(req, res, next);
});

app.post('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated?.()) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    user: {
      name: req.user.displayName,
      email: req.user.email,
      avatar: req.user.avatar
    }
  });
});

const FIELD_LIBRARY = [
  { key: 'name', keywords: ['姓名', '名字', '名称'], title: '你的姓名是？', type: 'text', required: true },
  { key: 'email', keywords: ['邮箱', '邮件', 'email'], title: '你的邮箱是？', type: 'text', required: true },
  { key: 'phone', keywords: ['手机', '电话', '联系方式'], title: '你的手机号是？', type: 'text', required: false },
  { key: 'company', keywords: ['公司', '单位'], title: '你的公司名称是？', type: 'text', required: false },
  { key: 'role', keywords: ['职位', '岗位', '角色', '部门'], title: '你的职位/部门是？', type: 'text', required: false },
  {
    key: 'gender',
    keywords: ['性别'],
    title: '你的性别是？',
    type: 'choice',
    required: false,
    options: ['男', '女', '不便透露', '其他']
  },
  {
    key: 'diet',
    keywords: ['饮食', '忌口', '餐食', '食物偏好'],
    title: '你的饮食偏好是？',
    type: 'choice',
    required: false,
    options: ['无特殊要求', '素食', '清真', '其他']
  },
  {
    key: 'joinMode',
    keywords: ['线上', '线下', '参会方式', '参与方式'],
    title: '你希望以哪种方式参加？',
    type: 'choice',
    required: false,
    options: ['线下', '线上']
  }
];

const QUIZ_BANKS = {
  openai: [
    {
      key: 'openai_foundation',
      title: 'OpenAI 最初成立的年份是？',
      options: ['2012', '2015', '2018', '2020'],
      answer: '2015'
    },
    {
      key: 'openai_chatgpt',
      title: 'ChatGPT 首次公开发布是在？',
      options: ['2021年', '2022年', '2023年', '2024年'],
      answer: '2022年'
    },
    {
      key: 'openai_api_usage',
      title: '若要在自己网站中调用 OpenAI 能力，最常见方式是？',
      options: ['直接改浏览器内核', '调用 OpenAI API', '安装显卡驱动即可', '只用 Google Form'],
      answer: '调用 OpenAI API'
    },
    {
      key: 'openai_model_choice',
      title: '在构建应用时，选择模型通常主要考虑哪项？',
      options: ['延迟与成本', '电脑屏幕尺寸', '操作系统颜色', '网线长度'],
      answer: '延迟与成本'
    },
    {
      key: 'openai_safety',
      title: '提示词工程中，为降低幻觉风险更推荐哪种做法？',
      options: ['不给任何上下文', '要求模型胡乱猜测', '提供清晰上下文与约束', '只输出表情'],
      answer: '提供清晰上下文与约束'
    },
    {
      key: 'openai_temperature',
      title: '在多数生成任务中，较低 temperature 通常意味着？',
      options: ['输出更随机', '输出更稳定', '响应一定更长', '一定更便宜'],
      answer: '输出更稳定'
    },
    {
      key: 'openai_embedding',
      title: '向量检索（RAG）里，embedding 主要用于？',
      options: ['图像压缩', '计算语义相似度', '网页动画', '数据库备份'],
      answer: '计算语义相似度'
    },
    {
      key: 'openai_eval',
      title: '上线前做评测（evaluation）的主要目的是什么？',
      options: ['让页面更好看', '减少功能波动并验证质量', '提高鼠标精度', '减少网速延迟'],
      answer: '减少功能波动并验证质量'
    }
  ],
  china: [
    {
      key: 'china_capital',
      title: '中国的首都是哪座城市？',
      options: ['上海', '北京', '广州', '深圳'],
      answer: '北京'
    },
    {
      key: 'china_national_day',
      title: '中国国庆日是每年的哪一天？',
      options: ['5月1日', '10月1日', '7月1日', '12月31日'],
      answer: '10月1日'
    },
    {
      key: 'china_longest_river',
      title: '中国最长的河流是？',
      options: ['黄河', '珠江', '长江', '黑龙江'],
      answer: '长江'
    },
    {
      key: 'china_highest_peak',
      title: '珠穆朗玛峰位于哪条山脉？',
      options: ['昆仑山脉', '秦岭', '横断山脉', '喜马拉雅山脉'],
      answer: '喜马拉雅山脉'
    },
    {
      key: 'china_currency',
      title: '中国的法定货币是？',
      options: ['日元', '人民币', '韩元', '新加坡元'],
      answer: '人民币'
    },
    {
      key: 'china_heritage',
      title: '以下哪个是中国古代著名建筑？',
      options: ['金字塔', '长城', '斗兽场', '泰姬陵'],
      answer: '长城'
    },
    {
      key: 'china_regions',
      title: '中国有多少个省级行政区（含省、自治区、直辖市、特别行政区）？',
      options: ['34个', '23个', '56个', '31个'],
      answer: '34个'
    },
    {
      key: 'china_festival',
      title: '中秋节最常见的传统食品是？',
      options: ['粽子', '汤圆', '月饼', '饺子'],
      answer: '月饼'
    }
  ],
  generic: [
    {
      key: 'generic_core',
      title: '你认为这个主题中最核心的知识点是什么？',
      options: ['基础概念', '历史背景', '实际应用', '综合理解']
    },
    {
      key: 'generic_difficulty',
      title: '你希望这份测验的难度是？',
      options: ['入门', '中等', '进阶', '混合']
    },
    {
      key: 'generic_goal',
      title: '你做这份测验的主要目标是？',
      options: ['自测', '教学', '面试准备', '活动互动']
    }
  ]
};

function isQuizIntent(prompt) {
  return /(quiz|测验|测试|考察|知识问答|知识测试)/i.test(prompt);
}

function parseDesiredQuestionCount(prompt) {
  const arabic = prompt.match(/(\d{1,2})\s*(题|道|questions?)/i);
  if (arabic?.[1]) {
    const n = Number(arabic[1]);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 3), 20);
  }

  const zhMap = {
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  const zh = prompt.match(/([三四五六七八九十])\s*(题|道)/);
  if (zh?.[1] && zhMap[zh[1]]) {
    return zhMap[zh[1]];
  }

  return 8;
}

function detectQuizTopic(prompt) {
  if (/(openai|chatgpt|gpt|llm|大模型|提示词|prompt|api)/i.test(prompt)) return 'openai';
  if (/(中国|中华|china|chinese)/i.test(prompt)) return 'china';
  return 'unknown';
}

function generateQuizQuestions(prompt) {
  const topic = detectQuizTopic(prompt);
  const bank = QUIZ_BANKS[topic] || QUIZ_BANKS.generic;
  const desiredCount = parseDesiredQuestionCount(prompt);
  const selected = bank.slice(0, Math.min(desiredCount, bank.length));
  return selected.map((q) => ({
    key: q.key,
    title: q.title,
    type: 'choice',
    required: true,
    options: q.options,
    correctAnswer: q.answer || '',
    points: q.answer ? 1 : 0
  }));
}

function inferTitle(prompt) {
  if (isQuizIntent(prompt)) {
    if (/(中国|中华|china|chinese)/i.test(prompt)) return '中国知识测验';
    return '知识测验';
  }
  if (/报名|活动|参会|参赛|讲座/.test(prompt)) return '活动报名表';
  if (/问卷|调研|调查/.test(prompt)) return '问卷调研表';
  if (/招聘|应聘|简历/.test(prompt)) return '岗位申请表';
  if (/预约|预定|排期/.test(prompt)) return '预约登记表';
  const summary = prompt.trim().slice(0, 28);
  return summary ? `${summary} - 自动生成表单` : '自动生成表单';
}

function normalizeToken(token) {
  return token
    .replace(/^[-*\d\s.)]+/, '')
    .replace(/(我要|我想要|请|帮我|需要|收集|包含|包括|字段|信息)/g, '')
    .trim();
}

function findFieldByText(text) {
  return FIELD_LIBRARY.find((f) => f.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase())));
}

function extractExplicitTokens(prompt) {
  const source = prompt.replace(/\r/g, '').trim();
  const matches = source.match(/(?:收集|包括|包含|字段|信息)[：: ]?(.+)/);
  if (!matches?.[1]) return [];
  return matches[1]
    .split(/[、，,\/和及与]/g)
    .map((t) => normalizeToken(t))
    .filter(Boolean);
}

function addQuestion(questions, seenKeys, question) {
  if (question.key && seenKeys.has(question.key)) return;
  if (question.key) seenKeys.add(question.key);
  questions.push(question);
}

function prettifyFieldName(name) {
  return String(name || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function decodeUploadFileName(name) {
  if (!name) return '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function getTextReadabilityScore(text) {
  if (!text) return 0;
  const normalized = text.replace(/\s/g, '');
  if (!normalized.length) return 0;

  const readableChars = normalized.match(
    /[\u4e00-\u9fa5A-Za-z0-9，。！？、；：“”‘’（）()【】《》,.!?;:'"_%@#&/+\-]/g
  ) || [];

  return readableChars.length / normalized.length;
}

function isLikelyParagraphField(fieldName) {
  return /(备注|说明|描述|建议|comment|note|description|feedback)/i.test(fieldName);
}

function buildQuestionFromField(fieldName) {
  const normalized = String(fieldName || '').trim();
  if (!normalized) return null;

  const known = findFieldByText(normalized);
  if (known) return { ...known };

  return {
    key: `field_${normalized.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`,
    title: `${prettifyFieldName(normalized)}（请填写）`,
    type: isLikelyParagraphField(normalized) ? 'paragraph' : 'text',
    required: false
  };
}

function parseCsvHeader(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const firstLine = lines[0].replace(/^\uFEFF/, '').trim();
  if (!firstLine) return [];
  return firstLine
    .split(/,|\t|;/g)
    .map((h) => h.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
}

function parseJsonKeys(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null) {
      return Object.keys(value[0]);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value);
    }
    return [];
  } catch {
    return [];
  }
}

function extractFieldsFromText(text) {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);

  return lines
    .filter((line) => line.length <= 40)
    .map((line) => line.replace(/^[-*\d\s.)]+/, '').trim())
    .filter((line) => line.length >= 2);
}

function extractQuestionsFromPdfText(text) {
  const normalized = text
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length < 20) {
    return [];
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => getTextReadabilityScore(line) >= 0.5);

  const explicitQuestions = lines
    .filter((line) => line.length >= 4 && line.length <= 120)
    .filter((line) => /[?？]$|吗$|^q[\d:：.\s]/i.test(line))
    .slice(0, 15)
    .map((line, idx) => ({
      key: `pdf_q_${idx + 1}`,
      title: /[?？]$|吗$/.test(line) ? line : `${line}（请填写）`,
      type: line.length > 36 ? 'paragraph' : 'text',
      required: false
    }));

  if (explicitQuestions.length) {
    return explicitQuestions;
  }

  const listedLines = lines
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[).、]\s*/, '').trim())
    .filter((line) => line.length >= 2 && line.length <= 60)
    .slice(0, 12);

  if (listedLines.length >= 3) {
    return listedLines.map((line, idx) => ({
      key: `pdf_list_${idx + 1}`,
      title: `${line}（请填写）`,
      type: isLikelyParagraphField(line) ? 'paragraph' : 'text',
      required: false
    }));
  }

  const sentenceCandidates = normalized
    .split(/[。.!！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 72)
    .filter((s) => !/^https?:\/\//i.test(s))
    .slice(0, 8);

  if (sentenceCandidates.length) {
    return sentenceCandidates.map((sentence, idx) => ({
      key: `pdf_sentence_${idx + 1}`,
      title: `请根据文档内容说明：${sentence}`,
      type: 'paragraph',
      required: false
    }));
  }

  const fallbackFields = extractFieldsFromText(normalized);
  return fallbackFields.map(buildQuestionFromField).filter(Boolean).slice(0, 15);
}

async function extractTextWithPdfOcr(fileBuffer) {
  let parser;
  try {
    parser = new PDFParse({ data: fileBuffer });
    const screenshots = await parser.getScreenshot({
      first: 2,
      scale: 1.5,
      imageBuffer: true,
      imageDataUrl: false
    });

    const pages = screenshots?.pages || [];
    if (!pages.length) return '';

    const chunks = [];
    for (const page of pages) {
      const imageBuffer = Buffer.from(page.data || []);
      if (!imageBuffer.length) continue;

      try {
        const result = await recognize(imageBuffer, 'chi_sim+eng');
        const text = result?.data?.text?.trim();
        if (text) chunks.push(text);
      } catch {
        const fallback = await recognize(imageBuffer, 'eng');
        const text = fallback?.data?.text?.trim();
        if (text) chunks.push(text);
      }
    }
    return chunks.join('\n').trim();
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }
}

async function extractSourceFromUploadedFile(file) {
  if (!file?.buffer?.length) {
    return {
      questions: [],
      fileType: '',
      textLength: 0,
      parseIssue: '',
      readabilityScore: 0,
      sourceText: '',
      extractMethod: ''
    };
  }

  const fileName = (file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const isPdf = fileName.endsWith('.pdf') || mime.includes('pdf');
  const fileType = isPdf ? 'pdf' : fileName.split('.').pop() || 'unknown';

  let fields = [];
  let questions = [];
  let textLength = 0;
  let parseIssue = '';
  let readabilityScore = 0;
  let usedOcr = false;
  let sourceText = '';
  let extractMethod = '';

  if (fileName.endsWith('.csv') || mime.includes('csv')) {
    const text = file.buffer.toString('utf8');
    textLength = text.length;
    sourceText = text;
    extractMethod = 'raw_text';
    fields = parseCsvHeader(text);
  } else if (fileName.endsWith('.json') || mime.includes('json')) {
    const text = file.buffer.toString('utf8');
    textLength = text.length;
    sourceText = text;
    extractMethod = 'raw_text';
    fields = parseJsonKeys(text);
  } else if (isPdf) {
    let parser;
    try {
      parser = new PDFParse({ data: file.buffer });
      const parsed = await parser.getText();
      const text = parsed?.text || '';
      textLength = text.trim().length;
      sourceText = text;
      extractMethod = 'pdf_text';
      readabilityScore = getTextReadabilityScore(text);
      questions = extractQuestionsFromPdfText(text);
      if (!textLength) {
        parseIssue = 'pdf_no_text';
      } else if (readabilityScore < 0.42) {
        parseIssue = 'pdf_low_quality_text';
        questions = [];
      }
    } catch (error) {
      console.error('Failed to parse PDF:', error.message);
      parseIssue = 'pdf_parse_failed';
      questions = [];
    } finally {
      if (parser) {
        await parser.destroy().catch(() => {});
      }
    }

    if (!questions.length) {
      try {
        const ocrText = await extractTextWithPdfOcr(file.buffer);
        const ocrReadability = getTextReadabilityScore(ocrText);
        if (ocrText && ocrReadability >= 0.35) {
          questions = extractQuestionsFromPdfText(ocrText);
          if (questions.length) {
            usedOcr = true;
            parseIssue = '';
            textLength = ocrText.length;
            readabilityScore = ocrReadability;
            sourceText = ocrText;
            extractMethod = 'pdf_ocr';
          }
        }
      } catch (error) {
        console.error('PDF OCR failed:', error.message);
      }
    }
  } else if (
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.tsv') ||
    mime.startsWith('text/')
  ) {
    const text = file.buffer.toString('utf8');
    textLength = text.length;
    sourceText = text;
    extractMethod = 'raw_text';
    fields = extractFieldsFromText(text);
  }

  if (!questions.length) {
    questions = fields.map(buildQuestionFromField).filter(Boolean);
  }

  return {
    questions: questions.slice(0, 15),
    fileType,
    textLength,
    parseIssue,
    readabilityScore,
    usedOcr,
    sourceText: sourceText.slice(0, 12000),
    extractMethod
  };
}

function parsePromptToQuestions(prompt, sourceQuestions = []) {
  if (sourceQuestions.length) {
    return sourceQuestions;
  }

  if (isQuizIntent(prompt)) {
    return generateQuizQuestions(prompt);
  }

  const questions = [];
  const seenKeys = new Set();
  const explicitTokens = extractExplicitTokens(prompt);

  for (const token of explicitTokens) {
    const field = findFieldByText(token);
    if (field) {
      addQuestion(questions, seenKeys, { ...field });
    } else if (token.length >= 2) {
      addQuestion(questions, seenKeys, {
        title: `${token}（请填写）`,
        type: 'text',
        required: false
      });
    }
  }

  for (const field of FIELD_LIBRARY) {
    if (field.keywords.some((k) => prompt.toLowerCase().includes(k.toLowerCase()))) {
      addQuestion(questions, seenKeys, { ...field });
    }
  }

  if (/报名|预约|申请|登记/.test(prompt)) {
    addQuestion(questions, seenKeys, { ...FIELD_LIBRARY.find((f) => f.key === 'name') });
    addQuestion(questions, seenKeys, { ...FIELD_LIBRARY.find((f) => f.key === 'email') });
    addQuestion(questions, seenKeys, {
      ...FIELD_LIBRARY.find((f) => f.key === 'phone'),
      required: true
    });
  }

  if (/问卷|反馈|调研|满意度|评价/.test(prompt)) {
    addQuestion(questions, seenKeys, {
      key: 'satisfaction',
      title: '整体满意度如何？',
      type: 'choice',
      required: true,
      options: ['非常满意', '满意', '一般', '不满意', '非常不满意']
    });
    addQuestion(questions, seenKeys, {
      key: 'feedback',
      title: '还有什么建议或补充？',
      type: 'paragraph',
      required: false
    });
  }

  if (!questions.length) {
    addQuestion(questions, seenKeys, { ...FIELD_LIBRARY.find((f) => f.key === 'name') });
    addQuestion(questions, seenKeys, { ...FIELD_LIBRARY.find((f) => f.key === 'email') });
    addQuestion(questions, seenKeys, {
      key: 'custom_need',
      title: '请描述你的具体需求',
      type: 'paragraph',
      required: true
    });
  }

  return questions.slice(0, 12);
}

function normalizeLlmQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions
    .map((q, index) => {
      const title = String(q?.title || '').trim();
      if (!title) return null;

      const type = ['text', 'paragraph', 'choice'].includes(q?.type) ? q.type : 'text';
      const required = Boolean(q?.required);
      const normalized = {
        key: q?.key || `llm_q_${index + 1}`,
        title,
        type,
        required,
        correctAnswer: String(q?.correctAnswer || '').trim(),
        points: Number.isFinite(Number(q?.points)) ? Math.max(0, Number(q.points)) : 0
      };

      if (type === 'choice') {
        const options = Array.isArray(q?.options)
          ? q.options.map((opt) => String(opt || '').trim()).filter(Boolean).slice(0, 8)
          : [];
        if (options.length < 2) {
          normalized.type = 'text';
          normalized.correctAnswer = '';
          normalized.points = 0;
        } else {
          normalized.options = options;
          if (normalized.correctAnswer && !options.includes(normalized.correctAnswer)) {
            normalized.correctAnswer = '';
            normalized.points = 0;
          }
        }
      } else {
        normalized.correctAnswer = '';
        normalized.points = 0;
      }

      return normalized;
    })
    .filter(Boolean)
    .slice(0, 15);
}

async function generateFormDraftWithLLM(prompt, sourceName, sourceText, quizRequested = false) {
  if (!OPENAI_API_KEY) return null;

  const schema = {
    name: 'google_form_draft',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isQuiz: { type: 'boolean' },
        title: { type: 'string' },
        description: { type: 'string' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 15,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              title: { type: 'string' },
              type: { type: 'string', enum: ['text', 'paragraph', 'choice'] },
              required: { type: 'boolean' },
              options: {
                type: 'array',
                items: { type: 'string' }
              },
              correctAnswer: { type: 'string' },
              points: { type: 'number' }
            },
            required: ['key', 'title', 'type', 'required', 'options', 'correctAnswer', 'points']
          }
        }
      },
      required: ['isQuiz', 'title', 'description', 'questions']
    }
  };

  const userInput = [
    `用户需求：${prompt || '未提供'}`,
    quizRequested ? `目标题量：${parseDesiredQuestionCount(prompt)} 题` : '',
    sourceName ? `上传文件：${sourceName}` : '',
    sourceText ? `文件内容节选：\n${sourceText.slice(0, 6000)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  const modelCandidates = [OPENAI_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini'].filter(Boolean);
  const tried = [];
  for (const model of modelCandidates) {
    if (tried.includes(model)) continue;
    tried.push(model);

    const payload = {
      model,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: schema },
      messages: [
        {
          role: 'system',
          content:
            '你是表单设计助手。输出必须是合法JSON，严格满足schema。优先生成可直接使用的Google Form草稿。quiz场景优先choice题，并为每道choice题填写correctAnswer和points（答案不要写进题干）。quiz必须严格围绕用户主题出题，禁止输出“你希望难度是/目标是”这类元问题。非quiz场景correctAnswer留空、points设0。'
        },
        {
          role: 'user',
          content: userInput
        }
      ]
    };

    const proxyCandidates = [
      process.env.OPENAI_PROXY,
      process.env.HTTPS_PROXY,
      process.env.HTTP_PROXY,
      'http://127.0.0.1:7890'
    ].filter(Boolean);

    async function requestOpenAI(proxyUrl = '') {
      return new Promise((resolve, reject) => {
        const req = https.request(
          'https://api.openai.com/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${OPENAI_API_KEY}`
            },
            agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
            timeout: 30000
          },
          (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
              data += chunk;
            });
            resp.on('end', () => {
              resolve({ status: resp.statusCode || 0, text: data, proxyUrl });
            });
          }
        );
        req.on('timeout', () => req.destroy(new Error('openai_request_timeout')));
        req.on('error', (e) => reject(e));
        req.write(JSON.stringify(payload));
        req.end();
      });
    }

    let responseData = null;
    let lastRequestErr = null;
    for (const proxyUrl of [...proxyCandidates, '']) {
      try {
        responseData = await requestOpenAI(proxyUrl);
        if (responseData.status) break;
      } catch (e) {
        lastRequestErr = e;
      }
    }

    if (!responseData) {
      console.error(`OpenAI request failed with model ${model}:`, lastRequestErr?.message || 'unknown');
      continue;
    }

    if (responseData.status < 200 || responseData.status > 299) {
      console.error(
        `OpenAI API error with model ${model}: ${responseData.status} ${responseData.text.slice(0, 200)}`
      );
      continue;
    }

    let data;
    try {
      data = JSON.parse(responseData.text);
    } catch {
      console.error(`OpenAI non-JSON response with model ${model}: ${responseData.text.slice(0, 200)}`);
      continue;
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.error(`OpenAI empty content with model ${model}`);
      continue;
    }

    const parsed = JSON.parse(content);
    const questions = normalizeLlmQuestions(parsed.questions);
    if (!questions.length) {
      console.error(`OpenAI no usable questions with model ${model}`);
      continue;
    }
    const answerKeyCount = questions.filter((q) => q.correctAnswer).length;
    const isQuiz = Boolean(parsed.isQuiz);
    if (quizRequested && (!isQuiz || answerKeyCount < Math.max(3, Math.floor(questions.length * 0.8)))) {
      console.error(`OpenAI quiz draft missing quiz signals with model ${model}`);
      continue;
    }

    return {
      isQuiz,
      title: String(parsed.title || '').trim() || inferTitle(prompt),
      description: String(parsed.description || '').trim() || `原始需求：${prompt || '无'}`,
      questions,
      llmModelUsed: model
    };
  }
  throw new Error(`All OpenAI model attempts failed: ${tried.join(', ')}`);
}

async function buildFormDraft(prompt, sourceQuestions = [], sourceName = '', sourceText = '') {
  const llmInputPrompt = prompt || `请根据文件内容生成可直接使用的表单：${sourceName || 'uploaded file'}`;
  const quizRequested = isQuizIntent(prompt);
  const desiredCount = parseDesiredQuestionCount(prompt);
  try {
    const llmDraft = await generateFormDraftWithLLM(llmInputPrompt, sourceName, sourceText, quizRequested);
    if (llmDraft) {
      const tunedQuestions = quizRequested ? llmDraft.questions.slice(0, desiredCount) : llmDraft.questions;
      return {
        ...llmDraft,
        questions: tunedQuestions,
        generationMode: 'llm',
        isQuiz: quizRequested || Boolean(llmDraft.isQuiz)
      };
    }
  } catch (error) {
    console.error('LLM draft generation failed:', error.message);
  }

  const title = sourceQuestions.length ? `${sourceName || '文件'} - 自动生成表单` : inferTitle(prompt);
  const questions = parsePromptToQuestions(prompt, sourceQuestions);
  const isQuiz = isQuizIntent(prompt) || questions.some((q) => q.correctAnswer);
  const quizTopic = detectQuizTopic(prompt);
  const needLlmForQuiz = isQuiz && quizTopic === 'unknown';
  const description = sourceQuestions.length
    ? `该表单由上传文件自动生成。\n文件：${sourceName || 'unknown'}\n共 ${sourceQuestions.length} 题。\n用户补充需求：${prompt || '无'}`
    : isQuizIntent(prompt)
      ? `该测验由对话自动生成。\n共 ${questions.length} 题。\n原始需求：${prompt}`
      : `该表单由对话自动生成。\n请根据实际情况填写。\n原始需求：${prompt}`;
  return { title, description, questions, generationMode: 'rule', isQuiz, needLlmForQuiz };
}

function toCreateItemRequest(question, index) {
  if (question.type === 'choice') {
    const choiceQuestion = {
      required: Boolean(question.required),
      choiceQuestion: {
        type: 'RADIO',
        options: (question.options || []).map((value) => ({ value }))
      }
    };
    if (question.correctAnswer && (question.options || []).includes(question.correctAnswer)) {
      choiceQuestion.grading = {
        pointValue: Number(question.points) > 0 ? Number(question.points) : 1,
        correctAnswers: {
          answers: [{ value: question.correctAnswer }]
        }
      };
    }

    return {
      createItem: {
        location: { index },
        item: {
          title: question.title,
          questionItem: {
            question: choiceQuestion
          }
        }
      }
    };
  }

  return {
    createItem: {
      location: { index },
      item: {
        title: question.title,
        questionItem: {
          question: {
            required: Boolean(question.required),
            textQuestion: { paragraph: question.type === 'paragraph' }
          }
        }
      }
    }
  };
}

app.post('/api/forms/generate', ensureAuth, upload.single('sourceFile'), async (req, res) => {
  const prompt = req.body?.prompt?.trim() || '';
  const source = await extractSourceFromUploadedFile(req.file);
  const sourceQuestions = source.questions;
  const sourceName = decodeUploadFileName(req.file?.originalname || '');
  const sourceText = source.sourceText || '';

  if (req.file && source.fileType === 'pdf' && !sourceQuestions.length) {
    let reason = 'PDF 解析失败，请换一个 PDF 重试，或上传 TXT/CSV/JSON。';
    if (source.parseIssue === 'pdf_no_text') {
      reason = '这个 PDF 没有可提取文字（通常是扫描图片 PDF）。请换可复制文字的 PDF，或上传 TXT/CSV/JSON。';
    } else if (source.parseIssue === 'pdf_low_quality_text') {
      reason = '这个 PDF 的可提取文本大多是乱码（编码映射缺失）。请换可复制文字版 PDF，或改用 OCR 后的文本文件。';
    }
    return res.status(400).json({
      error: 'pdf_parse_empty',
      message: reason
    });
  }

  if (!prompt && !sourceQuestions.length) {
    return res.status(400).json({
      error: 'invalid_prompt',
      message: 'Prompt or a supported file (.csv/.json/.txt/.md/.tsv/.pdf) is required.'
    });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${BASE_URL}/auth/google/callback`
    );

    oauth2Client.setCredentials({
      access_token: req.user.accessToken,
      refresh_token: req.user.refreshToken
    });

    const googleApiProxyUrl =
      process.env.GOOGLE_API_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    const googleApiAgent = googleApiProxyUrl ? new HttpsProxyAgent(googleApiProxyUrl) : undefined;
    const googleRequestOptions = googleApiAgent ? { agent: googleApiAgent } : {};

    const forms = google.forms({ version: 'v1', auth: oauth2Client });
    const draft = await buildFormDraft(prompt, sourceQuestions, sourceName, sourceText);
    if (draft.needLlmForQuiz && draft.generationMode !== 'llm') {
      return res.status(503).json({
        error: 'quiz_llm_required',
        message:
          '该主题的 quiz 需要 LLM 生成题目。请检查 OPENAI_API_KEY/OPENAI_MODEL，且确保服务端可访问 api.openai.com（可设置 OPENAI_PROXY=http://127.0.0.1:7890）。'
      });
    }

    const createResp = await withNetworkRetry('forms.create', () =>
      forms.forms.create(
        {
          requestBody: {
            info: {
              title: draft.title,
              documentTitle: draft.title
            }
          }
        },
        googleRequestOptions
      )
    );

    const formId = createResp.data.formId;
    if (!formId) {
      throw new Error('Google Forms API did not return formId');
    }

    const requests = [
      {
        updateFormInfo: {
          info: {
            description: draft.description
          },
          updateMask: 'description'
        }
      },
      ...(draft.isQuiz
        ? [{
            updateSettings: {
              settings: {
                quizSettings: {
                  isQuiz: true
                }
              },
              updateMask: 'quizSettings.isQuiz'
            }
          }]
        : []),
      ...draft.questions.map((q, idx) => toCreateItemRequest(q, idx))
    ];

    await withNetworkRetry('forms.batchUpdate', () =>
      forms.forms.batchUpdate(
        {
          formId,
          requestBody: { requests }
        },
        googleRequestOptions
      )
    );

    const formResp = await withNetworkRetry('forms.get', () =>
      forms.forms.get({ formId }, googleRequestOptions)
    );
    const responderUrl = formResp.data.responderUri;
    const editUrl = `https://docs.google.com/forms/d/${formId}/edit`;

    res.json({
      ok: true,
      formId,
      title: draft.title,
      questions: draft.questions.map((q) => q.title),
      editUrl,
      responderUrl,
      source: req.file
        ? {
            fileName: sourceName,
            fileType: source.fileType,
            textLength: source.textLength,
            readabilityScore: Number(source.readabilityScore.toFixed(2)),
            usedFileQuestions: sourceQuestions.length > 0,
            parseIssue: source.parseIssue || null,
            usedOcr: Boolean(source.usedOcr),
            extractMethod: source.extractMethod || 'unknown'
          }
        : null,
      generationMode: draft.generationMode,
      llmModelUsed: draft.llmModelUsed || null,
      isQuiz: Boolean(draft.isQuiz),
      answerKeyCount: draft.questions.filter((q) => q.correctAnswer).length
    });
  } catch (error) {
    const status = error?.code === 401 ? 401 : 500;
    res.status(status).json({
      error: 'form_generation_failed',
      message:
        status === 401
          ? 'Google authorization expired. Please login again.'
          : error.message || 'Failed to generate form.'
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
});
