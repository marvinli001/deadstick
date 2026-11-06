import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { Alert } from '@/components/arc/alert/alert';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { useSession } from '@/lib/session';
import styles from './McpAuthorize.module.css';

export default function McpAuthorize() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const request = params.get('request') ?? '';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(request);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authorization = useQuery({
    queryKey: ['mcp', 'authorization', request],
    queryFn: () =>
      api<{ client_name: string; redirect_uri: string; expires_at: string }>(
        `/auth/mcp/request/${request}`,
      ),
    enabled: valid && user?.role === 'admin',
    retry: false,
  });
  async function decide(approved: boolean) {
    setBusy(approved ? 'approve' : 'deny');
    setError(null);
    try {
      const result = await api<{ redirect: string }>(`/auth/mcp/request/${request}`, {
        method: 'POST',
        body: { approved },
      });
      window.location.assign(result.redirect);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(null);
    }
  }
  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <h1>连接 Deadstick</h1>
        {!valid ? (
          <Empty title="授权链接无效" action={<Link to="/console/mcp">返回 MCP</Link>} />
        ) : user?.role !== 'admin' ? (
          <Empty title="需要管理员身份" action={<Link to="/me">查看当前账号</Link>} />
        ) : authorization.isPending ? (
          <Loading lines={5} />
        ) : authorization.isError ? (
          <ErrorView error={authorization.error} onRetry={() => authorization.refetch()} />
        ) : (
          <>
            <div className={styles.client}>
              <span>{authorization.data.client_name}</span>
              <ArrowUpRight size={20} strokeWidth={1.5} aria-hidden="true" />
              <span className="mono">DEADSTICK</span>
            </div>
            <p className={styles.identity}>
              以 <strong>{user.display_name}</strong> 的管理员身份授权
            </p>
            <dl className={styles.permissions}>
              <div>
                <dt>管理</dt>
                <dd>机场、官网与订阅、留言、投稿、异常、监测设置</dd>
              </div>
              <div>
                <dt>读取</dt>
                <dd>审计、通知、任务、用户数据</dd>
              </div>
            </dl>
            <p className={styles.exclusion}>
              <LockKeyhole size={15} strokeWidth={1.75} aria-hidden="true" />
              Telegram 页面相关功能不开放
            </p>
            <p className={styles.callback}>
              返回地址 <span>{new URL(authorization.data.redirect_uri).host}</span>
            </p>
            <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={Boolean(busy)}
                loading={busy === 'deny'}
                onClick={() => void decide(false)}
              >
                取消
              </Button>
              <Button
                disabled={Boolean(busy)}
                loading={busy === 'approve'}
                onClick={() => void decide(true)}
              >
                允许连接
              </Button>
            </div>
            <p className={styles.foot}>
              可新增、修改和删除管理范围内的数据。授权有效期 30 天，可在后台 MCP 页面随时撤销。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
