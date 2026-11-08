import { Type, type TObject } from '@sinclair/typebox';
import {
  EndpointInput,
  Id,
  LeadInput,
  MonitorSettings,
  Page,
  ProviderInput,
  ProviderPatch,
  Resolution,
  SubmissionInput,
} from '../catalog/schemas.js';

const empty = Type.Object({});
const status = (values: string[]) =>
  Type.Optional(Type.Union(values.map((value) => Type.Literal(value))));
const reason = Type.String({ minLength: 3, maxLength: 2000 });
const evidenceUrls = Resolution.properties.evidenceUrls;

function operation(
  name: string,
  description: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { params?: TObject; query?: TObject; body?: TObject; destructive?: boolean } = {},
) {
  const params = options.params ?? empty;
  const query = options.query ?? empty;
  const body = options.body ?? empty;
  return {
    name,
    description,
    method,
    path,
    params,
    query,
    body,
    inputSchema: Type.Object(
      { ...params.properties, ...query.properties, ...body.properties },
      { additionalProperties: false },
    ),
    annotations: {
      readOnlyHint: method === 'GET',
      destructiveHint: options.destructive ?? method === 'DELETE',
      idempotentHint: ['GET', 'PUT', 'PATCH', 'DELETE'].includes(method),
      openWorldHint: false,
    },
  };
}

export const mcpTools = [
  operation('overview', '查看机场数量、状态和墓园统计。', 'GET', '/stats'),
  operation(
    'providers_list',
    '搜索机场，按状态筛选并分页。返回 total，可用于统计机场数量。',
    'GET',
    '/admin/providers',
    {
      query: Type.Object({
        ...Page,
        q: Type.Optional(Type.String({ maxLength: 4096 })),
        lifecycle: status(['active', 'suspected', 'dead']),
      }),
    },
  ),
  operation('provider_get', '查看机场详情和监测状态。', 'GET', '/admin/providers/:id', {
    params: Id,
  }),
  operation(
    'provider_create',
    '新增机场，endpoints 中同时填写官网 website 和订阅 subscription；订阅加密保存。',
    'POST',
    '/admin/providers',
    { body: ProviderInput },
  ),
  operation(
    'providers_import',
    '批量新增 1–100 个机场及其官网、订阅。整批事务：任何一项无效或 slug 重复均不写入。',
    'POST',
    '/admin/providers/batch',
    { body: Type.Object({ providers: Type.Array(ProviderInput, { minItems: 1, maxItems: 100 }) }) },
  ),
  operation(
    'provider_edit',
    '修改机场名称、slug、简介、标签、别名或可查运营日期，保留全部官网和订阅。opened_on 为可查运营起始日（可按最早可查资料填写），closed_on 为运营结束日，格式 YYYY-MM-DD，null 清除，省略保留；未知日期留空，不改变收录时间和跑路确认时间。运营日期仅用于跑路展示。',
    'PATCH',
    '/admin/providers/:id',
    {
      params: Id,
      body: ProviderPatch,
    },
  ),
  operation(
    'provider_replace',
    '完整替换机场资料和全部 endpoints。未提供的已有官网和订阅会被删除；局部修改请用 provider_edit、endpoint_add 或 endpoint_delete。',
    'PUT',
    '/admin/providers/:id',
    { params: Id, body: ProviderInput, destructive: true },
  ),
  operation(
    'provider_delete',
    '永久删除机场及其官网、订阅、检测记录、异常和留言，保留审计。',
    'DELETE',
    '/admin/providers/:id',
    { params: Id },
  ),
  operation(
    'providers_delete',
    '按 ID 批量永久删除 1–100 个机场及关联数据。整批事务；请先核对名单。',
    'POST',
    '/admin/providers/batch-delete',
    {
      body: Type.Object({
        ids: Type.Array(Id.properties.id, { minItems: 1, maxItems: 100, uniqueItems: true }),
      }),
      destructive: true,
    },
  ),
  operation(
    'endpoints_list',
    '列出机场官网与订阅的 ID、类型和域名；不返回订阅凭据。',
    'GET',
    '/admin/providers/:id/endpoints',
    { params: Id },
  ),
  operation(
    'endpoint_add',
    '向已有机场添加官网 website 或订阅 subscription，保留其他地址。',
    'POST',
    '/admin/providers/:id/endpoints',
    { params: Id, body: EndpointInput },
  ),
  operation(
    'endpoint_delete',
    '移除指定官网或订阅，机场至少保留一个地址。',
    'DELETE',
    '/admin/providers/:id/endpoints/:endpointId',
    { params: Type.Object({ ...Id.properties, endpointId: Id.properties.id }) },
  ),
  operation(
    'provider_monitoring',
    '启用或停用机场监测。',
    'PATCH',
    '/admin/providers/:id/monitoring',
    { params: Id, body: Type.Object({ enabled: Type.Boolean() }) },
  ),
  operation(
    'provider_check',
    '为机场排入一次检测任务。返回待执行任务 ID。',
    'POST',
    '/admin/providers/:id/check',
    { params: Id },
  ),
  operation('checks_list', '查看某机场的检测历史。', 'GET', '/providers/:id/checks', {
    params: Id,
    query: Type.Object(Page),
  }),
  operation(
    'check_results',
    '查看一次检测运行的端点结果；id 为检测运行 ID。',
    'GET',
    '/admin/checks/:id/results',
    { params: Id },
  ),
  operation(
    'submissions_list',
    '查看投稿及线索，返回 revision；审核和修改时使用该版本号。可传 id 查看指定条目。',
    'GET',
    '/admin/submissions',
    {
      query: Type.Object({
        ...Page,
        id: Type.Optional(Id.properties.id),
        status: status(['pending', 'needs_info', 'approved', 'rejected']),
      }),
    },
  ),
  operation(
    'submission_create',
    '新增机场投稿，等待审核。直接收录请用 provider_create。',
    'POST',
    '/submissions',
    { body: SubmissionInput },
  ),
  operation(
    'submission_lead',
    '为已有机场补充官网、异常、证据或复核线索，等待审核。',
    'POST',
    '/providers/:id/submissions',
    { params: Id, body: LeadInput },
  ),
  operation(
    'submission_edit',
    '修改待审核或待补充的投稿。使用当前 revision；省略已有订阅时保留订阅。',
    'PATCH',
    '/admin/submissions/:id',
    {
      params: Id,
      body: Type.Object({
        revision: Type.Integer({ minimum: 1 }),
        payload: Type.Union([SubmissionInput, LeadInput]),
      }),
    },
  ),
  operation(
    'submission_review',
    '通过、拒绝或要求补充投稿。须填写原因与当前 revision。',
    'POST',
    '/admin/submissions/:id/review',
    {
      params: Id,
      body: Type.Object({
        action: Type.Union([
          Type.Literal('approved'),
          Type.Literal('rejected'),
          Type.Literal('needs_info'),
        ]),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
        revision: Type.Integer({ minimum: 1 }),
      }),
    },
  ),
  operation(
    'submission_delete',
    '永久删除一条投稿；已收录的机场会保留。',
    'DELETE',
    '/admin/submissions/:id',
    { params: Id },
  ),
  operation(
    'incidents_list',
    '列出异常，可按状态筛选或传 id 查看指定异常。',
    'GET',
    '/admin/incidents',
    {
      query: Type.Object({
        ...Page,
        id: Type.Optional(Id.properties.id),
        status: status(['open', 'resolved', 'confirmed_dead', 'dismissed']),
      }),
    },
  ),
  operation(
    'incident_create',
    '为机场手动建立异常，进入人工复核。',
    'POST',
    '/admin/providers/:id/incidents',
    { params: Id, body: Type.Object({ summary: reason }) },
  ),
  operation('incident_edit', '修改未处理异常的摘要。', 'PATCH', '/admin/incidents/:id', {
    params: Id,
    body: Type.Object({ summary: reason }),
  }),
  operation(
    'incident_resolve',
    '处理异常：确认死亡 dead、恢复 recovered 或排除 dismissed。须填写审核备注和证据链接；reason 仅供内部留档，公开状态使用统一文案。',
    'POST',
    '/admin/incidents/:id/resolve',
    { params: Id, body: Resolution },
  ),
  operation(
    'provider_revive',
    '凭证据恢复已确认死亡的机场。',
    'POST',
    '/admin/providers/:id/revive',
    { params: Id, body: Type.Object({ reason, evidenceUrls }) },
  ),
  operation(
    'memorials_list',
    '查看留言，可按状态筛选或传 id 查看指定留言。',
    'GET',
    '/admin/memorials',
    {
      query: Type.Object({
        ...Page,
        id: Type.Optional(Id.properties.id),
        status: status(['pending', 'visible', 'hidden']),
      }),
    },
  ),
  operation(
    'memorial_create',
    '给已确认死亡的机场添加留言，等待审核。',
    'POST',
    '/providers/:id/memorials',
    {
      params: Id,
      body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }) }),
    },
  ),
  operation('memorial_edit', '修改留言正文。', 'PATCH', '/admin/memorials/:id/content', {
    params: Id,
    body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }) }),
  }),
  operation('memorial_moderate', '通过或隐藏留言。', 'PATCH', '/admin/memorials/:id', {
    params: Id,
    body: Type.Object({ visible: Type.Boolean() }),
  }),
  operation('memorial_delete', '永久删除留言。', 'DELETE', '/admin/memorials/:id', { params: Id }),
  operation('settings_get', '查看监测设置。', 'GET', '/admin/settings/monitor'),
  operation(
    'settings_update',
    '保存监测设置。请先读取现有设置，保留无需修改的值。',
    'PUT',
    '/admin/settings/monitor',
    { body: MonitorSettings },
  ),
  operation('audit_list', '分页读取审计记录。', 'GET', '/admin/audit', {
    query: Type.Object(Page),
  }),
  operation('notifications_list', '分页读取通知投递状态。', 'GET', '/admin/notifications', {
    query: Type.Object(Page),
  }),
  operation('jobs_list', '读取检测任务队列，按状态筛选。', 'GET', '/admin/jobs', {
    query: Type.Object({ ...Page, status: status(['pending', 'running', 'done', 'failed']) }),
  }),
  operation(
    'users_list',
    '读取用户资料，按邮箱、名称、Telegram ID 或角色筛选。不返回密码或会话。',
    'GET',
    '/admin/users',
    {
      query: Type.Object({
        ...Page,
        q: Type.Optional(Type.String({ maxLength: 254 })),
        role: status(['user', 'moderator', 'admin']),
      }),
    },
  ),
  operation('system_health', '读取 worker、检测任务和通知队列状态。', 'GET', '/admin/health'),
];

export function mcpAllows(method: string, route: string) {
  return mcpTools.some((tool) => tool.method === method && tool.path === route);
}
