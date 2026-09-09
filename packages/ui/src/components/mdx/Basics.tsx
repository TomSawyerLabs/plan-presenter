/**
 * Small layout/content primitives plus the HTML-tag overrides that resolve
 * session-relative media URLs and local-path links.
 */

import type { AnchorHTMLAttributes, ImgHTMLAttributes, MediaHTMLAttributes, ReactNode, SourceHTMLAttributes } from "react";
import { useSessionOptional } from "../../state.tsx";
import { hrefToPath, isLocalPathHref } from "./Folder.tsx";
import { Mermaid } from "./Mermaid.tsx";

type DataAttrs = { [attr: `data-${string}`]: string | undefined };

function pickData(props: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props as Record<string, unknown>).filter(([k]) => k.startsWith("data-")));
}

/** Resolve a relative URL against the session's file endpoint. */
export function useResolveUrl() {
  const session = useSessionOptional();
  return (src: string | undefined): string | undefined => {
    if (!src || !session?.session) return src;
    if (/^(https?:|data:|blob:|\/\/)/i.test(src) || src.startsWith("/api/")) return src;
    if (src.startsWith("/")) return src;
    return session.transport.fileUrl(session.session.id, src) + `?v=${session.assetVersion}`;
  };
}

export function Img(props: ImgHTMLAttributes<HTMLImageElement>) {
  const resolve = useResolveUrl();
  return <img {...props} src={resolve(props.src)} loading="lazy" />;
}

export function Video(props: MediaHTMLAttributes<HTMLVideoElement> & { src?: string } & DataAttrs) {
  const resolve = useResolveUrl();
  return <video controls playsInline {...props} src={resolve(props.src)} className="pp-media" />;
}

export function Audio(props: MediaHTMLAttributes<HTMLAudioElement> & { src?: string } & DataAttrs) {
  const resolve = useResolveUrl();
  return <audio controls {...props} src={resolve(props.src)} className="pp-media" />;
}

export function Source(props: SourceHTMLAttributes<HTMLSourceElement>) {
  const resolve = useResolveUrl();
  return <source {...props} src={resolve(props.src)} />;
}

export function Anchor(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const session = useSessionOptional();
  const resolve = useResolveUrl();
  const href = props.href ?? "";
  if (href && isLocalPathHref(href)) {
    const path = hrefToPath(href);
    return (
      <a
        {...props}
        href={href}
        className="pp-local-link"
        data-pp-interactive=""
        onClick={(e) => {
          e.preventDefault();
          session?.openPath(path).catch((err) => alert(`Could not open ${path}: ${(err as Error).message}`));
        }}
      >
        {props.children}
      </a>
    );
  }
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      {...props}
      href={external ? href : resolve(href)}
      target={external ? "_blank" : props.target}
      rel={external ? "noreferrer noopener" : props.rel}
      data-pp-interactive=""
    />
  );
}

/** ```mermaid fences render as diagrams; everything else is a plain code block. */
export function Pre(props: { children?: ReactNode } & Record<string, unknown>) {
  const child = props.children as { props?: { className?: string; children?: string } } | undefined;
  const cls = child?.props?.className ?? "";
  const data = pickData(props);
  if (/language-mermaid\b/.test(cls) && typeof child?.props?.children === "string") {
    return <Mermaid chart={child.props.children} {...(data as DataAttrs)} />;
  }
  const lang = /language-([\w-]+)/.exec(cls)?.[1];
  return (
    <div className="pp-code" {...data}>
      {lang && <span className="pp-code-lang">{lang}</span>}
      <pre>{props.children}</pre>
    </div>
  );
}

export interface CalloutProps extends DataAttrs {
  kind?: "info" | "note" | "tip" | "warning" | "danger" | "success";
  title?: string;
  children?: ReactNode;
}

const CALLOUT_ICON: Record<NonNullable<CalloutProps["kind"]>, string> = {
  info: "ℹ️",
  note: "📝",
  tip: "💡",
  warning: "⚠️",
  danger: "⛔",
  success: "✅",
};

export function Callout(props: CalloutProps) {
  const { kind = "info", title, children } = props;
  return (
    <aside className={`pp-callout pp-callout-${kind}`} {...pickData(props)}>
      <div className="pp-callout-title">
        <span aria-hidden="true">{CALLOUT_ICON[kind]}</span> {title ?? kind[0]!.toUpperCase() + kind.slice(1)}
      </div>
      <div className="pp-callout-body">{children}</div>
    </aside>
  );
}

export interface SectionProps extends DataAttrs {
  id?: string;
  title?: string;
  children?: ReactNode;
}

export function Section(props: SectionProps) {
  return (
    <section className="pp-section" id={props.id} data-pp-target={props.id} {...pickData(props)}>
      {props.title && <h2 className="pp-section-title">{props.title}</h2>}
      {props.children}
    </section>
  );
}

export function Columns(props: { children?: ReactNode; min?: string } & DataAttrs) {
  return (
    <div className="pp-columns" style={{ ["--pp-col-min" as string]: props.min ?? "18rem" }} {...pickData(props)}>
      {props.children}
    </div>
  );
}

export function Column(props: { children?: ReactNode } & DataAttrs) {
  return (
    <div className="pp-column" {...pickData(props)}>
      {props.children}
    </div>
  );
}

export interface FigureProps extends DataAttrs {
  src?: string;
  alt?: string;
  caption?: ReactNode;
  children?: ReactNode;
  width?: string | number;
}

export function Figure(props: FigureProps) {
  const resolve = useResolveUrl();
  return (
    <figure className="pp-figure" style={props.width ? { maxWidth: props.width } : undefined} {...pickData(props)}>
      {props.src ? <img src={resolve(props.src)} alt={props.alt ?? ""} loading="lazy" /> : props.children}
      {props.caption && <figcaption>{props.caption}</figcaption>}
    </figure>
  );
}

export function Stat(props: { label: string; value: ReactNode; hint?: ReactNode } & DataAttrs) {
  return (
    <div className="pp-stat" {...pickData(props)}>
      <div className="pp-stat-value">{props.value}</div>
      <div className="pp-stat-label">{props.label}</div>
      {props.hint && <div className="pp-stat-hint">{props.hint}</div>}
    </div>
  );
}
