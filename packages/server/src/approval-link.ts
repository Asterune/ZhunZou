import { createHmac, timingSafeEqual } from 'node:crypto';

import { formatTicketId, type DecisionTicket } from '@zhunzou/shared';

export interface ApprovalTokenPayload {
  ticketId: string;
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Build a compact, URL-safe, expiring approval token. */
export function buildApprovalToken(
  ticketId: string,
  expiresAt: number,
  secret: string,
): string {
  const payload = `${ticketId}.${expiresAt}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyApprovalToken(
  token: string,
  secret: string,
  now = Date.now(),
): ApprovalTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [ticketId, expiresRaw, provided] = parts;
  if (!ticketId || !expiresRaw || !provided) return null;
  if (!/^[1-9]\d*$/.test(ticketId) || !/^\d+$/.test(expiresRaw)) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;

  const expected = signature(`${ticketId}.${expiresAt}`, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  return { ticketId, expiresAt };
}

export function buildApprovalUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/a/${token}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function riskLabel(risk: string | undefined): string {
  if (risk === 'destructive') return '<span class="risk">高风险</span>';
  if (risk === 'caution') return '<span class="caution">需谨慎</span>';
  return '';
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; --ink:#211f1c; --muted:#6f6a63; --line:#e5e0d8; --paper:#faf8f4; --card:#fffdf9; --red:#93000b; --green:#2f6b4f; --amber:#8a5a00; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  main { width:min(680px,100%); margin:0 auto; padding:20px 16px 40px; }
  .eyebrow { color:var(--red); font-size:11px; letter-spacing:.18em; text-transform:uppercase; }
  h1 { margin:4px 0 2px; font-size:24px; line-height:1.25; }
  h1 .id { color:var(--red); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .meta { margin:0 0 16px; color:var(--muted); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:0 12px 34px -30px rgba(33,31,28,.5); }
  .notice { margin:0 0 12px; padding:10px 12px; border-radius:10px; background:#fff2d8; color:var(--amber); font-size:13px; }
  .brief { display:grid; gap:10px; padding:12px; border-radius:10px; background:var(--paper); }
  .brief span { display:block; color:var(--muted); font-size:11px; }
  .brief p { margin:2px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .question { border-left:4px solid var(--red); padding-left:10px; }
  fieldset { border:0; margin:18px 0 0; padding:0; }
  legend { font-size:12px; font-weight:700; color:var(--muted); letter-spacing:.08em; }
  .option { display:flex; align-items:flex-start; gap:10px; margin-top:8px; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  .option:has(input:checked) { border-color:var(--red); background:#fff7f6; }
  .option input { margin-top:4px; accent-color:var(--red); }
  .key { display:grid; place-items:center; width:24px; height:24px; flex:0 0 24px; border-radius:999px; background:var(--ink); color:#fff; font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .option strong { display:block; font-size:14px; }
  .option small { display:block; color:var(--muted); font-size:12px; }
  .rec { margin-left:auto; flex:0 0 auto; border-radius:4px; background:var(--red); color:#fff; font-size:10px; font-weight:700; padding:1px 6px; }
  .risk { margin-left:auto; border-radius:4px; background:#fbe3e1; color:#a3231b; font-size:10px; font-weight:700; padding:1px 6px; }
  .caution { margin-left:auto; border-radius:4px; background:#fff2d8; color:var(--amber); font-size:10px; font-weight:700; padding:1px 6px; }
  .field { display:block; margin-top:14px; color:var(--muted); font-size:12px; }
  textarea { display:block; width:100%; margin-top:6px; padding:10px; border:1px solid var(--line); border-radius:10px; background:#fff; color:var(--ink); font:inherit; resize:vertical; }
  .confirm { display:flex; gap:8px; align-items:flex-start; margin-top:12px; color:#a3231b; font-size:12px; }
  .confirm input { margin-top:3px; accent-color:#a3231b; }
  button { width:100%; margin-top:14px; padding:13px 16px; border:0; border-radius:10px; background:var(--red); color:#fff; font:700 15px/1 inherit; }
  .hint { color:var(--muted); font-size:11px; text-align:center; }
  a { color:var(--red); }
  .result { text-align:center; padding:28px 8px; }
  .result .mark { display:grid; place-items:center; width:54px; height:54px; margin:0 auto 12px; border-radius:999px; background:#e8f3ec; color:var(--green); font-size:26px; font-weight:700; }
  .result.bad .mark { background:#fbe3e1; color:#a3231b; }
  .result h2 { margin:0; font-size:20px; }
  .result p { color:var(--muted); overflow-wrap:anywhere; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderApprovalPage(
  ticket: DecisionTicket,
  token: string,
  baseUrl = '',
  notice = '',
  selectedOption = ticket.recommendedOption,
  customInstruction = '',
): string {
  const options = ticket.options
    .map((option) => {
      const checked = option.key === selectedOption ? ' checked' : '';
      const recommended =
        option.key === ticket.recommendedOption
          ? '<span class="rec">推荐</span>'
          : '';
      const pros = option.prosCons
        ? `<small>${escapeHtml(option.prosCons)}</small>`
        : '';
      return `<label class="option">
  <input type="radio" name="selectedOption" value="${escapeHtml(option.key)}"${checked}>
  <span class="key">${escapeHtml(option.key)}</span>
  <span><strong>${escapeHtml(option.label)}</strong>${pros}</span>
  ${recommended}${riskLabel(option.risk)}
</label>`;
    })
    .join('\n');

  const action = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/a/${token}/resolve`
    : `/a/${token}/resolve`;
  const hasDestructive = ticket.options.some(
    (option) => option.risk === 'destructive',
  );

  const body = `<div class="eyebrow">准奏 · 待批奏折</div>
<h1><span class="id">${escapeHtml(formatTicketId(ticket.id))}</span> · ${escapeHtml(ticket.projectName)}</h1>
<p class="meta">${escapeHtml(ticket.env)} · ${escapeHtml(new Date(ticket.createdAt).toLocaleString('zh-CN'))}</p>
<div class="card">
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}
  <section class="brief">
    <div><span>已完成进展</span><p>${escapeHtml(ticket.doneSummary)}</p></div>
    <div class="question"><span>请旨阻塞关键抉择</span><p>${escapeHtml(ticket.blockerQuestion)}</p></div>
    <div><span>候命下一步</span><p>${escapeHtml(ticket.nextStepPlan)}</p></div>
  </section>
  <form method="post" action="${escapeHtml(action)}">
    <fieldset><legend>抉择分支</legend>${options}</fieldset>
    <label class="field">批红备忘 / 补充指令（选填）
      <textarea name="customInstruction" rows="2" maxlength="2000" placeholder="例如：先只改登录页">${escapeHtml(customInstruction)}</textarea>
    </label>
    ${
      hasDestructive
        ? '<label class="confirm"><input type="checkbox" name="confirmDestructive" value="true"> 我确认这是高风险 / 不可逆操作</label>'
        : ''
    }
    <button type="submit">准 奏</button>
  </form>
  <p class="hint">点击后 Agent 会立即恢复执行；高风险选项必须勾选确认。</p>
  ${baseUrl ? `<p class="hint"><a href="${escapeHtml(baseUrl)}">打开完整看板</a></p>` : ''}
</div>`;

  return layout(`准奏 · ${formatTicketId(ticket.id)}`, body);
}

export function renderApprovalResultPage(
  title: string,
  message: string,
  ok: boolean,
  baseUrl = '',
): string {
  const body = `<div class="card result${ok ? '' : ' bad'}">
  <div class="mark">${ok ? '✓' : '!'}</div>
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(message)}</p>
  ${baseUrl ? `<p><a href="${escapeHtml(baseUrl)}">打开完整看板</a></p>` : ''}
</div>`;
  return layout(title, body);
}
