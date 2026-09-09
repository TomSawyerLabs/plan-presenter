import { SessionView } from "./components/SessionView.tsx";
import { SessionProvider } from "./state.tsx";
import type { Transport } from "./transport.ts";

export interface PlanPresenterProps {
  transport: Transport;
  sessionId: string;
  pageId?: string | null;
  onPageChange?: (pageId: string) => void;
  onBack?: () => void;
  onError?: (err: unknown) => void;
}

/** One session, ready to drop into any React tree. */
export function PlanPresenter({
  transport,
  sessionId,
  pageId,
  onPageChange,
  onBack,
  onError,
}: PlanPresenterProps) {
  return (
    <SessionProvider
      key={sessionId}
      transport={transport}
      sessionId={sessionId}
      pageId={pageId}
      onPageChange={onPageChange}
      onError={onError}
    >
      <SessionView onBack={onBack} />
    </SessionProvider>
  );
}
