export type Role = 'user' | 'moderator' | 'admin';
export type Lifecycle = 'active' | 'suspected' | 'dead';
export type Health = 'unknown' | 'healthy' | 'degraded' | 'down';
export type TributeKind = 'flower' | 'candle' | 'incense';

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  role: Role;
  telegram_id: string | null;
  has_password?: boolean;
}

export interface Session {
  user: User;
  csrfToken: string;
}

export interface Provider {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  aliases: string[];
  lifecycle: Lifecycle;
  health: Health;
  last_checked_at: string | null;
  death_at: string | null;
  opened_on: string | null;
  closed_on: string | null;
  epitaph: string | null;
  created_at: string;
  tribute_count?: number;
}

export interface Incident {
  id: string;
  status: 'open' | 'resolved' | 'confirmed_dead' | 'dismissed';
  summary: string;
  resolution: string | null;
  evidence_urls: string[];
  created_at: string;
  resolved_at: string | null;
}

export interface ProviderDetail extends Provider {
  websites: { id: string; label: string; public_url: string }[];
  incidents: Incident[];
  tributes: { kind: TributeKind; count: number }[];
  following: boolean | null;
  follower_count: number;
  memorial_count: number;
}

export interface CheckSummary {
  health: Health;
  website: { total: number; up: number; blocked?: number };
  subscription: { total: number; up: number };
  nodeProbe: 'tcp' | 'proxy' | 'none';
}

export interface CheckRun {
  id: string;
  health: Health;
  summary: CheckSummary;
  created_at: string;
}

export interface Memorial {
  id: string;
  body: string;
  created_at: string;
  display_name: string;
}

export interface Stats {
  total: number;
  dead: number;
  suspected: number;
  healthy: number;
  tributes: number;
}

export type SubmissionStatus = 'pending' | 'needs_info' | 'approved' | 'rejected';
export type LeadKind = 'website' | 'abnormal' | 'evidence' | 'review';
export interface LeadInput {
  kind: LeadKind;
  body: string;
  website?: string;
  evidenceUrls?: string[];
}
export interface MySubmission {
  id: string;
  name: string;
  status: SubmissionStatus;
  reason: string | null;
  provider_id: string | null;
  incident_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  kind: 'provider' | LeadKind;
  provider: {
    name: string;
    description: string;
    tags: string[];
    report?: { kind: LeadKind; body: string; evidenceUrls: string[] };
  };
  websites: { url: string; label: string }[];
  subscription_count: number;
}

export interface EndpointInput {
  kind: 'website' | 'subscription';
  label?: string;
  url: string;
}

export interface ProviderInput {
  name: string;
  slug: string;
  aliases?: string[];
  description?: string;
  tags?: string[];
  endpoints: EndpointInput[];
}

export interface AdminProvider extends Provider {
  enabled: boolean;
  failure_streak: number;
  next_check_at: string;
  updated_at: string;
  website_count?: number;
  subscription_count?: number;
}

export interface AdminEndpoint {
  id: string;
  kind: 'website' | 'subscription';
  label: string;
  display_host: string;
  public_url: string | null;
  created_at: string;
}

export interface AdminSubmission {
  id: string;
  revision: number;
  user_id: string;
  kind: 'provider' | LeadKind;
  provider_id: string | null;
  incident_id: string | null;
  websites: { url: string; label: string }[];
  subscription_count: number;
  provider: {
    name: string;
    slug: string;
    description: string;
    tags: string[];
    report?: { kind: LeadKind; body: string; evidenceUrls: string[] };
  };
  endpoint_count: number;
  status: SubmissionStatus;
  reason: string | null;
  created_at: string;
}

export interface AdminIncident extends Incident {
  manual_review: boolean;
  leads: { id: string; kind: LeadKind }[];
  provider_id: string;
  provider_name: string;
  reviewer_id: string | null;
}

export interface CheckJob {
  id: string;
  provider_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  error_code: string | null;
  available_at: string;
  created_at: string;
  finished_at: string | null;
}

export interface EndpointResult {
  id: string;
  endpoint_id: string | null;
  kind: 'website' | 'subscription';
  ok: boolean;
  http_status: number | null;
  latency_ms: number;
  error_code: string | null;
  node_count: number | null;
  reachable_nodes: number | null;
  sampled_nodes: number | null;
  subscription_expired: boolean | null;
  quota_exhausted: boolean | null;
  probe_mode: 'tcp' | 'proxy' | null;
  probe_error_code: string | null;
}

export interface AdminMemorial {
  id: string;
  provider_id: string;
  provider_name: string;
  user_id: string;
  body: string;
  status: 'pending' | 'visible' | 'hidden';
  created_at: string;
  author_name?: string;
}

export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string;
  role: Role;
  telegram_id: string | null;
  disabled: boolean;
  created_at: string;
}

export interface MonitorSettings {
  intervalHours: number;
  batchSize: number;
  concurrency: number;
  failureThreshold: number;
  checkTimeoutMs: number;
  nodeSampleSize: number;
  retentionDays: number;
}

export interface HealthReport {
  workers: { id: string; last_seen_at: string; healthy: boolean }[];
  checks: { status: string; count: number }[];
  notifications: { status: string; count: number }[];
}

export interface NotificationRow {
  id: string;
  chat_id: string;
  topic_id: number | null;
  method?: string;
  status: 'pending' | 'running' | 'sent' | 'failed';
  attempts: number;
  error_code: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface TelegramChat {
  id: string;
  title: string;
  kind: 'group' | 'admin';
  topic_id: number | null;
  enabled: boolean;
  created_at: string;
}

export interface TelegramGroup extends TelegramChat {
  approval_status: 'pending' | 'approved' | 'rejected';
  bot_member_status: string;
  bot_can_send: boolean;
  query_enabled: boolean;
  guest_enabled: boolean;
  notification_policy: { enabled?: boolean };
  username: string | null;
  inviter_telegram_id: string | null;
  inviter_name: string | null;
  joined_at: string | null;
  left_at: string | null;
  reviewed_at: string | null;
  admin_note: string;
  updated_at: string;
}

export interface BotUpdate {
  update_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total?: number;
}
