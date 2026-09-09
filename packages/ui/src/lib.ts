/**
 * Embeddable surface. A host application (e.g. t3code) renders:
 *
 *   <PlanPresenter transport={myTransport} sessionId="s-abc" />
 *
 * where `myTransport` implements `Transport` over whatever RPC it already has.
 * Styles are in ./styles.css (scoped under `.pp-shell` / `.pp-*`).
 */

export { App } from "./App.tsx";
export { SessionProvider, useSession, useSessionOptional, type SessionState } from "./state.tsx";
export { HttpTransport, TransportError, type Transport, type HttpTransportOptions } from "./transport.ts";
export { SessionView } from "./components/SessionView.tsx";
export { SessionList } from "./components/SessionList.tsx";
export { PageView } from "./components/PageView.tsx";
export { FeedbackSidebar } from "./components/FeedbackSidebar.tsx";
export { mdxComponents } from "./components/mdx/index.ts";
export * from "./components/mdx/index.ts";
export { PlanPresenter, type PlanPresenterProps } from "./PlanPresenter.tsx";
