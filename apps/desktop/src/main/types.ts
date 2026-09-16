export type Connection = {
  accessToken: string;
  expiresAt: string | null;
};

export type Provider = "instagram" | "threads";

export type Account = {
  id: string;
  user_id?: string;
  username: string;
  account_type?: string;
  media_count?: number;
  name?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
};

export type ThreadsAccount = {
  id: string;
  username: string;
  threads_profile_picture_url?: string;
};

export type MessageButton =
  | { type: "web_url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

export type QuickReply = { title: string; payload: string };

export type OutgoingMessage = {
  text: string;
  buttons: MessageButton[];
  quickReplies: QuickReply[];
  buttonPrompt: string;
};

export type FollowUp = { id: string; delayMinutes: number; message: OutgoingMessage };

export type RuleSource = "comment" | "dm" | "story" | "live";

export type RuleStats = {
  matched: number;
  publicReplied: number;
  dmSent: number;
  dmFailed: number;
  followUpSent: number;
  buttonTapped: number;
  read: number;
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  sources: RuleSource[];
  keywords: string[];
  matchMode: "contains" | "exact";
  mediaIds: string[];
  publicReplies: string[];
  message: OutgoingMessage | null;
  followUps: FollowUp[];
  cooldownHours: number;
  stats: RuleStats;
  createdAt: string;
  updatedAt: string;
};

export type MediaAsset = {
  id: string;
  kind: "image" | "video";
  url: string | null;
  localPath: string | null;
  brokerId: string | null;
  fileName: string;
  size: number | null;
};

export type PostKind = "image" | "carousel" | "reel" | "story" | "threads";

export type PostStatus = "scheduled" | "publishing" | "published" | "failed" | "missed" | "canceled";

export type ThreadsItem = { text: string; media: MediaAsset[] };

export type ScheduledPost = {
  id: string;
  kind: PostKind;
  scheduledAt: string;
  status: PostStatus;
  caption: string;
  media: MediaAsset[];
  cover: MediaAsset | null;
  shareToFeed: boolean;
  threads: ThreadsItem[];
  attachRuleId: string | null;
  publishedId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type CalendarMemo = {
  id: string;
  date: string;
  title: string;
  note: string;
  color: string;
};

export type PendingMessage = {
  id: string;
  ruleId: string;
  recipientId: string;
  dueAt: string;
  message: OutgoingMessage;
  attempts: number;
  createdAt: string;
};

export type LogCategory = "inbound" | "outbound" | "post" | "system" | "insights" | "seminar" | "link";

export type LogEntry = {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  category: LogCategory;
  title: string;
  detail: string;
};

export type AccountSnapshot = {
  date: string;
  capturedAt: string;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  reach: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
  websiteClicks: number | null;
};

export type MediaSnapshot = {
  mediaId: string;
  date: string;
  capturedAt: string;
  mediaType: string;
  productType: string;
  caption: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  timestamp: string | null;
  metrics: Record<string, number>;
};

export type StorySnapshot = {
  storyId: string;
  capturedAt: string;
  timestamp: string | null;
  mediaType: string;
  mediaUrl: string | null;
  metrics: Record<string, number>;
};

export type TrackedLink = {
  slug: string;
  url: string;
  label: string;
  source: string;
  trackedUrl: string;
  createdAt: string;
  total: number;
  daily: Record<string, number>;
  sources: Record<string, number>;
};

export type SeminarDate = { id: string; startsAt: string; capacity: number | null };

export type SeminarReminder = { id: string; hoursBefore: number; text: string };

export type SeminarApplication = {
  id: string;
  dateId: string;
  name: string;
  email: string | null;
  lineUserId: string | null;
  createdAt: string;
  thanksSentAt: string | null;
  remindersSent: string[];
};

export type Seminar = {
  id: string;
  title: string;
  description: string;
  dates: SeminarDate[];
  liffId: string | null;
  thanksMessage: string;
  reminders: SeminarReminder[];
  applications: SeminarApplication[];
  enabled: boolean;
  publicUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Contact = {
  username: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastOutboundRuleId: string | null;
  lastReadAt: string | null;
  readCounted: boolean;
};

export type Settings = {
  automationEnabled: boolean;
  pollIntervalSec: number;
  brokerEventIntervalSec: number;
  recentMediaCount: number;
  missedGraceMinutes: number;
  insightsEnabled: boolean;
  storySnapshotIntervalMin: number;
  pollingMode: "auto" | "always" | "never";
  liveCommentsEnabled: boolean;
  localApiEnabled: boolean;
  localApiPort: number;
  theme: "system" | "light" | "dark";
  accent: string;
  defaultCaption: string;
  privacyContact: string;
};

export type AppData = {
  version: 1;
  settings: Settings;
  rules: Rule[];
  posts: ScheduledPost[];
  memos: CalendarMemo[];
  pending: PendingMessage[];
  logs: LogEntry[];
  accountSnapshots: AccountSnapshot[];
  mediaSnapshots: MediaSnapshot[];
  storySnapshots: StorySnapshot[];
  seminars: Seminar[];
  links: TrackedLink[];
  cooldowns: Record<string, string>;
  contacts: Record<string, Contact>;
  seen: { comments: string[]; messages: string[]; brokerCursor: number };
  lastInsightsDate: string | null;
  lastStorySnapshotAt: string | null;
  automationSince: string | null;
};

export type BrokerCapabilities = {
  webhooks: boolean;
  threads: boolean;
  media: boolean;
  links: boolean;
  seminars: boolean;
  publicBaseUrl: string;
};

export type BrokerEvent = {
  id: number;
  at: string;
  type: "webhook" | "seminar.application";
  payload: unknown;
};

export const DEFAULT_SETTINGS: Settings = {
  automationEnabled: false,
  pollIntervalSec: 60,
  brokerEventIntervalSec: 10,
  recentMediaCount: 10,
  missedGraceMinutes: 30,
  insightsEnabled: true,
  storySnapshotIntervalMin: 60,
  pollingMode: "auto",
  liveCommentsEnabled: false,
  localApiEnabled: false,
  localApiPort: 42_814,
  theme: "system",
  accent: "#7c3aed",
  defaultCaption: "",
  privacyContact: "",
};

export function emptyStats(): RuleStats {
  return { matched: 0, publicReplied: 0, dmSent: 0, dmFailed: 0, followUpSent: 0, buttonTapped: 0, read: 0 };
}

export function emptyMessage(): OutgoingMessage {
  return { text: "", buttons: [], quickReplies: [], buttonPrompt: "こちらからどうぞ👇" };
}

export function emptyData(): AppData {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    rules: [],
    posts: [],
    memos: [],
    pending: [],
    logs: [],
    accountSnapshots: [],
    mediaSnapshots: [],
    storySnapshots: [],
    seminars: [],
    links: [],
    cooldowns: {},
    contacts: {},
    seen: { comments: [], messages: [], brokerCursor: 0 },
    lastInsightsDate: null,
    lastStorySnapshotAt: null,
    automationSince: null,
  };
}
