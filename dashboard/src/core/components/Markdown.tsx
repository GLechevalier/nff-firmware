// Markdown — shared agent-text renderer (ChatTab bubbles, Improve-tab plans).
// Tailwind preflight strips element styles, so restore them scoped here.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const STRUCTURE =
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 ' +
  '[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-bold ' +
  '[&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] ' +
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
  '[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse ' +
  '[&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1 ' +
  '[&_blockquote]:border-l-2 [&_blockquote]:pl-3 ' +
  '[&_a]:underline [&_hr]:my-3 ' +
  'text-ink [&_code]:bg-ink/5 [&_pre]:border-faint [&_pre]:bg-ink/5 ' +
  '[&_th]:border-faint [&_td]:border-faint ' +
  '[&_blockquote]:border-faint [&_blockquote]:text-muted [&_hr]:border-faint';

export function Markdown({
  text,
  className = 'text-sm',
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`${STRUCTURE} ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
