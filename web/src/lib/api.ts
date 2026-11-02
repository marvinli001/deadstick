export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; query?: Query } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return parse<T>(
    await fetch(withQuery(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

/** Multipart POST; the browser sets the boundary header itself. */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return parse<T>(
    await fetch(path, { method: 'POST', headers, credentials: 'include', body: form }),
  );
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? '',
    );
  }
  return data as T;
}

const messages: Record<string, string> = {
  INVALID_CREDENTIALS: '邮箱或密码不对',
  CONFLICT: '已存在',
  VALIDATION: '格式不对',
  UNAUTHORIZED: '请先登录',
  FORBIDDEN: '没有权限',
  DISABLED: '账号已停用',
  CSRF: '页面已过期，请刷新',
  ORIGIN: '来源不被允许',
  NOT_FOUND: '找不到',
  NOT_DEAD: '还没入土',
  ALREADY_DEAD: '已经入土',
  ALREADY_REVIEWED: '已经处理过',
  SUBMISSION_CHANGED: '投稿已更新，请刷新审核后重试',
  INCIDENT_OPEN: '已有未处理的异常',
  MONITOR_DISABLED: '监测已停用或已入土',
  DUPLICATE_ENDPOINT: '地址重复',
  DUPLICATE_PROVIDER: '可能已经收录，请补充到已有机场',
  DUPLICATE_SUBMISSION: '已有同名或同官网的投稿待审核',
  WEBSITE_REQUIRED: '填一下官网',
  NOT_AWAITING_INFO: '这条投稿暂时不能补交',
  SUBMISSION_KIND: '投稿类型不匹配',
  NOT_CONFIGURED: 'Telegram 未配置',
  BOT_USERNAME: '请填写机器人用户名',
  BOT_USERNAME_MISMATCH: '用户名与 Bot Token 不匹配',
  OIDC_CREDENTIALS: '请同时配置 Client ID 和 Client Secret',
  HTTPS_REQUIRED: '公网地址需要使用 HTTPS，请修改部署配置 PUBLIC_URL',
  INVALID_STATE: '登录已过期，请重试',
  TELEGRAM_AUTH: 'Telegram 授权失败',
  TELEGRAM_CANCELLED: '已取消 Telegram 授权',
  RECIPIENT_REVOKED: '接收权限已撤销',
  ALREADY_LINKED: '这个 Telegram 已绑定其他账号',
  IDENTITY_MISMATCH: 'Telegram 身份不一致',
  REPLAY: '请重新打开 Mini App',
  LAST_ADMIN: '至少保留一位管理员',
  CHAT_TYPE: '会话类型不匹配',
  NOT_REVIEWER: '先把这个 Telegram 绑定到审核员账号',
  NOT_LINKED: '还没绑定 Telegram',
  LAST_LOGIN_METHOD: '先设置邮箱密码，才能解绑',
  TOO_LARGE: '文件超过 20 MB',
  INVALID_URL: '地址无效',
  UNSAFE_URL: '只接受公网 http(s) 地址，端口 80、443、8080、8443',
  BLOCKED_ADDRESS: '不能使用内网地址',
  FST_ERR_RATE_LIMIT: '操作太频繁，稍后再试',
};

export function errorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 429) return '操作太频繁，稍后再试';
    if (error.code.startsWith('TELEGRAM_') && !messages[error.code]) return 'Telegram 拒绝了请求';
    return messages[error.code] ?? (error.status >= 500 ? '服务出错，稍后再试' : '请求被拒绝');
  }
  return '网络不通';
}

export function telegramErrorText(code: string | null) {
  return code ? (messages[code] ?? 'Telegram 登录失败') : null;
}
