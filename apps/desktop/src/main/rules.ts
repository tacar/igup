import type { OutgoingMessage, Rule, RuleSource } from "./types.js";

export const CHAIN_PREFIX = "igup";

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function keywordMatches(rule: Pick<Rule, "keywords" | "matchMode">, text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return rule.keywords.some((keyword) => {
    const wanted = normalizeText(keyword);
    if (!wanted) return false;
    return rule.matchMode === "exact" ? normalized === wanted : normalized.includes(wanted);
  });
}

export type MatchContext = { source: RuleSource; text: string; mediaId?: string | null };

export function findMatchingRules(rules: Rule[], context: MatchContext): Rule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || !rule.sources.includes(context.source)) return false;
    if ((context.source === "comment" || context.source === "live") && rule.mediaIds.length > 0) {
      if (!context.mediaId || !rule.mediaIds.includes(context.mediaId)) return false;
    }
    return keywordMatches(rule, context.text);
  });
}

export function pickReply(patterns: string[], random: () => number = Math.random): string | null {
  const candidates = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))] ?? null;
}

export function cooldownKey(ruleId: string, userId: string): string {
  return `${ruleId}:${userId}`;
}

export function isCoolingDown(cooldowns: Record<string, string>, key: string, hours: number, now = Date.now()): boolean {
  if (hours <= 0) return false;
  const last = cooldowns[key];
  if (!last) return false;
  return now - Date.parse(last) < hours * 3_600_000;
}

export function withinMessagingWindow(lastInboundAt: string | null | undefined, now = Date.now(), hours = 24): boolean {
  if (!lastInboundAt) return false;
  return now - Date.parse(lastInboundAt) < hours * 3_600_000;
}

export function encodeChainPayload(originRuleId: string, targetRuleId: string): string {
  return `${CHAIN_PREFIX}:${originRuleId}:${targetRuleId}`;
}

export function decodeChainPayload(payload: string | undefined | null): { originRuleId: string; targetRuleId: string } | null {
  if (!payload) return null;
  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== CHAIN_PREFIX || !parts[1] || !parts[2]) return null;
  return { originRuleId: parts[1], targetRuleId: parts[2] };
}

/** Polling mode cannot see quick-reply payloads, so a tapped quick reply is recognized by its title. */
export function findQuickReplyByTitle(rules: Rule[], text: string): { originRuleId: string; targetRuleId: string } | null {
  const wanted = normalizeText(text);
  if (!wanted) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const messages: OutgoingMessage[] = [rule.message, ...rule.followUps.map((followUp) => followUp.message)].filter((message): message is OutgoingMessage => Boolean(message));
    for (const message of messages) {
      for (const reply of message.quickReplies) {
        const chain = decodeChainPayload(reply.payload);
        if (chain && normalizeText(reply.title) === wanted) return chain;
      }
    }
  }
  return null;
}

export function validateRule(rule: Rule): string[] {
  const problems: string[] = [];
  if (!rule.name.trim()) problems.push("ルール名を入力してください。");
  if (rule.sources.length === 0) problems.push("反応する入口（コメント / DM / ストーリーズ返信 / ライブ）を1つ以上選んでください。");
  if (rule.keywords.filter((keyword) => keyword.trim()).length === 0) problems.push("キーワードを1つ以上入力してください。");
  if (rule.publicReplies.length > 3) problems.push("公開返信は3パターンまでです。");
  if (rule.message) {
    if (rule.message.buttons.length > 3) problems.push("ボタンは3つまでです。");
    for (const button of rule.message.buttons) {
      if (!button.title.trim()) problems.push("ボタンのタイトルを入力してください。");
      if (button.type === "web_url" && !/^https?:\/\//.test(button.url)) problems.push(`ボタン「${button.title}」のURLを確認してください。`);
    }
    if (rule.message.quickReplies.length > 13) problems.push("クイックリプライは13個までです。");
    if (rule.message.text.length > 1_000) problems.push("DM本文は1,000文字以内にしてください。");
  }
  if (rule.cooldownHours < 0) problems.push("クールダウンは0時間以上にしてください。");
  for (const followUp of rule.followUps) {
    if (followUp.delayMinutes < 1) problems.push("時間差送信は1分以上後に設定してください。");
    if (followUp.delayMinutes > 23 * 60) problems.push("時間差送信は23時間以内に設定してください（Instagramの24時間ルール）。");
  }
  return problems;
}
