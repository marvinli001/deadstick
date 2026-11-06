import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { Filter, PageHead, Table, usePaged, type Column } from './shared';
import styles from './Mcp.module.css';

type Harness = 'wevir' | 'codex' | 'claude' | 'cursor' | 'other';
interface Connection {
  id: string;
  client_name: string;
  user_name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

function Connect({ url }: { url: string }) {
  const [harness, setHarness] = useState<Harness>('wevir');
  const shellUrl = `'${url.replaceAll("'", "'\\''")}'`;
  const clients = {
    wevir: {
      filename: '接入指令',
      language: 'text',
      code: `请将这个 MCP 连接添加到 Wevir，使用 OAuth 登录：\n${JSON.stringify({ name: 'deadstick', transport: 'http', url, auth: 'oauth' }, null, 2)}`,
      hint: '复制到 Wevir 会话，添加后在「插件」中登录。',
    },
    codex: {
      filename: '终端',
      language: 'sh',
      code: `codex mcp add deadstick --url ${shellUrl}\ncodex mcp login deadstick`,
      hint: '在终端运行，随后在浏览器中登录并授权。',
    },
    claude: {
      filename: '终端',
      language: 'sh',
      code: `claude mcp add --transport http --scope user deadstick ${shellUrl}\nclaude mcp login deadstick`,
      hint: '在终端运行，也可在 Claude Code 中用 /mcp 登录。',
    },
    cursor: {
      filename: '.cursor/mcp.json',
      language: 'json',
      code: JSON.stringify({ mcpServers: { deadstick: { url } } }, null, 2),
      hint: '合并到 Cursor 的 MCP 配置，在 MCP 设置中登录。',
    },
    other: {
      filename: 'MCP 配置',
      language: 'json',
      code: JSON.stringify({ mcpServers: { deadstick: { type: 'http', url } } }, null, 2),
      hint: '选择 Streamable HTTP 和 OAuth，配置格式以客户端为准。',
    },
  };
  const selected = clients[harness];
  return (
    <div className={styles.connect}>
      <div className={styles.endpoint}>
        <code>{url}</code>
        <CopyButton value={url} label="复制地址" />
      </div>
      <Filter
        label="接入客户端"
        value={harness}
        onChange={setHarness}
        options={[
          { value: 'wevir', label: 'Wevir' },
          { value: 'codex', label: 'Codex' },
          { value: 'claude', label: 'Claude Code' },
          { value: 'cursor', label: 'Cursor' },
          { value: 'other', label: '其他' },
        ]}
      />
      <CodeBlock code={selected.code} filename={selected.filename} language={selected.language} />
      <p className={styles.hint}>{selected.hint}</p>
      <dl className={styles.scope}>
        <div>
          <dt>管理</dt>
          <dd>机场、官网与订阅、留言、投稿、异常、监测设置</dd>
        </div>
        <div>
          <dt>读取</dt>
          <dd>审计、通知、任务、用户</dd>
        </div>
        <div>
          <dt>不开放</dt>
          <dd>Telegram 页面相关功能</dd>
        </div>
      </dl>
    </div>
  );
}

export default function Mcp() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [active, setActive] = useState<Connection | null>(null);
  const config = useQuery({
    queryKey: ['admin', 'mcp'],
    queryFn: () => api<{ url: string }>('/admin/mcp'),
  });
  const connections = usePaged<Connection>(
    ['admin', 'mcp', 'connections'],
    '/admin/mcp/connections',
  );
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/admin/mcp/connections/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'mcp', 'connections'] });
      setActive(null);
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });
  const columns: Column<Connection>[] = [
    { key: 'client_name', label: '客户端' },
    { key: 'user_name', label: '管理员' },
    { key: 'created_at', label: '授权时间', render: (_, row) => dateTime(row.created_at) },
    {
      key: 'last_used_at',
      label: '最近使用',
      render: (_, row) => (row.last_used_at ? ago(row.last_used_at) : '尚未使用'),
    },
    {
      key: 'id',
      label: '状态',
      render: (_, row) =>
        row.revoked_at ? (
          '已撤销'
        ) : new Date(row.expires_at).getTime() <= Date.now() ? (
          '已到期'
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setActive(row)}>
            撤销
          </Button>
        ),
    },
  ];
  return (
    <>
      <PageHead title="MCP" />
      {config.isPending ? (
        <Loading lines={5} />
      ) : config.isError ? (
        <ErrorView error={config.error} onRetry={() => config.refetch()} />
      ) : (
        <Connect url={config.data.url} />
      )}
      <section className={styles.connections}>
        <h2>已授权连接</h2>
        {connections.isPending ? (
          <Loading lines={3} />
        ) : connections.isError ? (
          <ErrorView error={connections.error} onRetry={() => connections.refetch()} />
        ) : (
          <Table
            caption="MCP 授权连接"
            empty="暂无授权连接"
            rows={connections.items}
            columns={columns}
          />
        )}
        {connections.pager}
      </section>
      <Dialog
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setActive(null);
        }}
      >
        <DialogContent
          title="撤销连接"
          description={active ? `撤销 ${active.client_name} 的管理员授权？` : ''}
        >
          <p>撤销后，该客户端需重新登录才能访问。</p>
          <div className={styles.dialogActions}>
            <Button variant="secondary" disabled={revoke.isPending} onClick={() => setActive(null)}>
              取消
            </Button>
            <Button loading={revoke.isPending} onClick={() => active && revoke.mutate(active.id)}>
              确认撤销
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
