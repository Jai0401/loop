/**
 * Domain types — the language of Loop's memory layer.
 *
 * A "decision" is something the team committed to.
 * An "action item" is something someone owes the team.
 * A "topic" is what the conversation was about (clustering aid).
 * An "extraction" is the AI's structured read of a Slack message batch.
 */

export type ISODateString = string;
export type SlackUserId = string; // Uxxxxx
export type SlackChannelId = string; // Cxxxxx
export type SlackTeamId = string; // Txxxxx
export type SlackTs = string; // message timestamp "1234567890.123456"

export interface User {
  id: string; // internal UUID
  slack_user_id: SlackUserId;
  slack_team_id: SlackTeamId;
  display_name: string;
  real_name?: string;
  avatar_url?: string;
  first_seen_at: ISODateString;
  last_seen_at: ISODateString;
}

export interface Channel {
  id: string;
  slack_channel_id: SlackChannelId;
  slack_team_id: SlackTeamId;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  watched: boolean; // should Loop ingest this channel?
  joined_at: ISODateString;
}

export type ActionStatus = 'open' | 'in_progress' | 'done' | 'cancelled' | 'overdue';

export interface ActionItem {
  id: string;
  team_id: string;
  channel_id: string; // FK -> channels.id
  source_message_ts?: SlackTs;
  source_thread_ts?: SlackTs;
  title: string;
  description?: string;
  owner_user_id?: string; // FK -> users.id, may be null if not yet assigned
  due_at?: ISODateString;
  status: ActionStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  confidence: number; // 0..1, how sure the extractor was
  created_at: ISODateString;
  updated_at: ISODateString;
  completed_at?: ISODateString;
  cancelled_at?: ISODateString;
  external_refs: ExternalRef[]; // e.g. Linear ticket, Jira issue
}

export type DecisionConfidence = 'stated' | 'inferred' | 'tentative';

export interface Decision {
  id: string;
  team_id: string;
  channel_id: string;
  source_message_ts?: SlackTs;
  source_thread_ts?: SlackTs;
  summary: string; // 1-2 sentence decision
  rationale?: string;
  participants: string[]; // user.id list
  confidence: DecisionConfidence;
  supersedes?: string; // previous decision.id this updates
  created_at: ISODateString;
  embedding?: number[]; // vector for semantic search
}

export interface Topic {
  id: string;
  label: string;
  description?: string;
  last_seen_at: ISODateString;
  mention_count: number;
}

export interface ExternalRef {
  system: 'linear' | 'jira' | 'notion' | 'github' | 'google_docs' | 'slack_canvas';
  external_id: string;
  url: string;
  title?: string;
  created_at: ISODateString;
}

/* ------------------------ Extraction payloads ------------------------ */

/**
 * What the AI returns when asked to read a Slack message batch.
 * Validated with Zod before storage.
 */
export interface ExtractionResult {
  decisions: ExtractedDecision[];
  action_items: ExtractedActionItem[];
  topics: ExtractedTopic[];
}

export interface ExtractedDecision {
  summary: string;
  rationale?: string;
  participant_slack_ids: SlackUserId[];
  confidence: DecisionConfidence;
  source_message_ts: SlackTs;
  evidence_quote?: string;
}

export interface ExtractedActionItem {
  title: string;
  description?: string;
  owner_slack_id?: SlackUserId;
  due_iso?: string; // ISO 8601 date or datetime
  priority: 'low' | 'medium' | 'high' | 'urgent';
  confidence: number; // 0..1
  source_message_ts: SlackTs;
  evidence_quote?: string;
}

export interface ExtractedTopic {
  label: string;
  mention_count: number;
}

/* ------------------------ Slack primitives ------------------------ */

export interface SlackMessage {
  ts: SlackTs;
  thread_ts?: SlackTs;
  channel: SlackChannelId;
  user: SlackUserId;
  text: string;
  blocks?: unknown[];
  files?: Array<{ id: string; mimetype: string; name: string; url_private?: string }>;
  reactions?: Array<{ name: string; count: number; users: SlackUserId[] }>;
  reply_count?: number;
  reply_users_count?: number;
  is_edited?: boolean;
  subtype?: string;
}

export interface SlackConversationBatch {
  channel: SlackChannelId;
  messages: SlackMessage[];
  oldest_ts: SlackTs;
  latest_ts: SlackTs;
}
