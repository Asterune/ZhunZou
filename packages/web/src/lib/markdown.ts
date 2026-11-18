import MarkdownItFactory, {
  type MarkdownIt,
  type RendererRule,
} from 'markdown-it';

/**
 * The agent writes GFM-flavoured Markdown (tables, fenced code, lists). The
 * renderer deliberately keeps `html: false`: raw HTML in the answer stays
 * escaped text, which is the sanitiser we need for content the hub never
 * authored itself.
 *
 * `breaks: true` matches how people type in chat: a single newline is a line
 * break, not a paragraph join.
 */
const md: MarkdownIt = new MarkdownItFactory({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const fallbackLinkOpen: RendererRule = (
  tokens,
  idx,
  options,
  _env,
  self,
) => self.renderToken(tokens, idx, options);

const defaultLinkOpen = md.renderer.rules.link_open ?? fallbackLinkOpen;

const linkOpenRule: RendererRule = (
  tokens,
  idx,
  options,
  env,
  self,
) => {
  // A link in an answer should not navigate the dashboard away, and must not
  // hand the opened page a `window.opener` to script us back.
  tokens[idx]?.attrSet('target', '_blank');
  tokens[idx]?.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.link_open = linkOpenRule;

/** Render agent text as safe Markdown. */
export function renderMarkdown(text: string): string {
  return md.render(text);
}
