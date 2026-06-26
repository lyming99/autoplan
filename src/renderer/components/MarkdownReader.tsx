import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdown>;
type MarkdownComponents = NonNullable<ReactMarkdownProps['components']>;
type UrlTransform = NonNullable<ReactMarkdownProps['urlTransform']>;
type ScopeFileOpenMode = 'system' | 'folder' | 'vscode' | 'command';

export type MarkdownReaderProps = {
  markdown?: string | null;
  className?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  onOpenScopeFile?: (filePath: string) => void;
};

const allowedUrlProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const scopeCommentPattern = /`<!--\s*(?:scope|scopes|files?|影响范围|并发键)\s*[:=：]\s*([^>`]+?)\s*-->`/gi;
const scopeSplitPattern = /[,，、;；]+/;
const scopeFileSettingsKey = 'autoplan.scopeFileOpenSettings';

function normalizeSafeUrl(url: string): string | undefined {
  const trimmedUrl = url.trim();

  if (!trimmedUrl || trimmedUrl.startsWith('//')) {
    return undefined;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmedUrl)) {
    try {
      const parsedUrl = new URL(trimmedUrl);
      return allowedUrlProtocols.has(parsedUrl.protocol) ? trimmedUrl : undefined;
    } catch {
      return undefined;
    }
  }

  return trimmedUrl;
}

const safeUrlTransform: UrlTransform = (url) => normalizeSafeUrl(url) ?? '';

function toVisibleHtmlComment(comment: string) {
  if (!comment.includes('`')) return `\`${comment}\``;
  return `\`\` ${comment} \`\``;
}

function exposeHtmlComments(markdown: string) {
  let fence: { char: string; length: number } | null = null;

  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

      if (fence) {
        if (fenceMatch && fenceMatch[1].startsWith(fence.char) && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        return line;
      }

      const visibleLine = line.replace(/<!--.*?-->/g, toVisibleHtmlComment);

      if (fenceMatch) {
        fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      }

      return visibleLine;
    })
    .join('\n');
}

const markdownComponents: MarkdownComponents = {
  a({ node: _node, href, children, ...props }) {
    const safeHref = href ? normalizeSafeUrl(href) : undefined;
    const isExternalLink = Boolean(safeHref && /^https?:\/\//i.test(safeHref));

    return (
      <a
        {...props}
        href={safeHref}
        target={isExternalLink ? '_blank' : undefined}
        rel={isExternalLink ? 'noreferrer noopener' : undefined}
      >
        {children}
      </a>
    );
  },
  input({ node: _node, type, checked, ...props }) {
    if (type !== 'checkbox') return <input {...props} type={type} />;

    return (
      <input
        {...props}
        type="checkbox"
        checked={Boolean(checked)}
        readOnly
        disabled
        aria-label={checked ? '已勾选任务' : '未勾选任务'}
      />
    );
  },
  pre({ node: _node, ...props }) {
    return <pre {...props} tabIndex={0} aria-label="可滚动代码块" />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-reader-table" role="region" aria-label="可横向滚动表格" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
};

function normalizeScopeFilePath(value: string) {
  return value.trim().replace(/^['"`[{(]+|['"`\]})]+$/g, '').replace(/\\/g, '/');
}

function childrenText(children: ReactNode) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.filter((child) => typeof child === 'string').join('');
  return '';
}

function renderScopeCommentParts(text: string, onOpenScopeFile?: (filePath: string) => void) {
  const parts: ReactNode[] = [];
  const openScopeFile = onOpenScopeFile || openScopeFileFromReader;
  let lastIndex = 0;
  for (const match of text.matchAll(scopeCommentPattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const files = String(match[1] || '')
      .split(scopeSplitPattern)
      .map((item) => normalizeScopeFilePath(item))
      .filter(Boolean);
    parts.push(
      <span className="markdown-scope-files" key={`scope-${match.index}`}>
        <span className="markdown-scope-label">scope</span>
        {files.length ? files.map((filePath) => {
          const special = filePath === 'unknown' || filePath === 'validation';
          return (
            <button
              type="button"
              key={`${match.index}-${filePath}`}
              className={`markdown-scope-link mono${special ? ' special' : ''}`}
              disabled={special}
              title={special ? '该 scope 不是可打开文件' : `打开 ${filePath}`}
              onClick={() => openScopeFile(filePath)}
            >
              {filePath}
            </button>
          );
        }) : <span className="markdown-scope-link special mono">unknown</span>}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

function readProjectIdFromLocation() {
  const match = window.location.pathname.match(/\/projects\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function readScopeFileSettings(): { mode: ScopeFileOpenMode; command: string } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(scopeFileSettingsKey) || 'null');
    const mode = parsed?.mode === 'folder' || parsed?.mode === 'vscode' || parsed?.mode === 'command'
      ? parsed.mode
      : 'system';
    return { mode, command: String(parsed?.command || '') };
  } catch {
    return { mode: 'system', command: '' };
  }
}

async function openScopeFileFromReader(filePath: string) {
  const projectId = readProjectIdFromLocation();
  const settings = readScopeFileSettings();
  try {
    const result = await (window.autoplan as typeof window.autoplan & {
      openWorkspaceFile?: (input: {
        projectId: number;
        filePath: string;
        mode: ScopeFileOpenMode;
        command?: string;
      }) => Promise<{ ok: boolean; error: string | null }>;
    }).openWorkspaceFile?.({ projectId, filePath, mode: settings.mode, command: settings.command });
    if (!result?.ok) throw new Error(result?.error || '文件打开失败');
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

function createMarkdownComponents(onOpenScopeFile?: (filePath: string) => void): MarkdownComponents {
  return {
    ...markdownComponents,
    p({ node: _node, children, ...props }) {
      const text = childrenText(children);
      const nextChildren = text ? renderScopeCommentParts(text, onOpenScopeFile) : children;
      return <p {...props}>{nextChildren}</p>;
    },
    li({ node: _node, children, ...props }) {
      const text = childrenText(children);
      const nextChildren = text ? renderScopeCommentParts(text, onOpenScopeFile) : children;
      return <li {...props}>{nextChildren}</li>;
    },
    code({ node: _node, children, ...props }) {
      const text = childrenText(children);
      if (!props.className && text.startsWith('<!--') && /scope|scopes|files?|影响范围|并发键/i.test(text)) {
        return <>{renderScopeCommentParts(`\`${text}\``, onOpenScopeFile)}</>;
      }
      return <code {...props}>{children}</code>;
    },
  };
}

export function MarkdownReader({
  markdown,
  className,
  emptyMessage = '暂无计划正文',
  ariaLabel = 'Markdown 正文',
  onOpenScopeFile,
}: MarkdownReaderProps) {
  const content = markdown ?? '';
  const classes = ['markdown-reader', className].filter(Boolean).join(' ');

  if (!content.trim()) {
    return (
      <div className={`${classes} markdown-reader-empty`} role="status" aria-live="polite">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={classes} role="region" aria-label={ariaLabel}>
      <ReactMarkdown
        components={createMarkdownComponents(onOpenScopeFile)}
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrlTransform}
      >
        {exposeHtmlComments(content)}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownReader;
