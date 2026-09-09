import type { MDXComponents } from "mdx/types";
import { Anchor, Audio, Callout, Column, Columns, Figure, Img, Pre, Section, Source, Stat, Video } from "./Basics.tsx";
import { Chart } from "./Chart.tsx";
import { Folder } from "./Folder.tsx";
import { Mermaid } from "./Mermaid.tsx";
import { Question } from "./Question.tsx";

/**
 * The component set available to every page. Agents use these by name in
 * MDX; HTML tag overrides handle media URLs and local-path links.
 */
export const mdxComponents: MDXComponents = {
  // Tag overrides
  a: Anchor,
  img: Img,
  pre: Pre,
  video: Video,
  audio: Audio,
  source: Source,
  // Primitives
  Chart,
  Mermaid,
  Folder,
  Question,
  Callout,
  Section,
  Columns,
  Column,
  Figure,
  Stat,
  Video,
  Audio,
  Image: Img,
};

export { Anchor, Audio, Callout, Chart, Column, Columns, Figure, Folder, Img, Mermaid, Pre, Question, Section, Source, Stat, Video };
