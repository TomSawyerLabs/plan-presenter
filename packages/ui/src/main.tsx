import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { HttpTransport } from "./transport.ts";
import "./styles.css";

// `?host=http://other-machine:27411` points the UI at a remote host.
// `?reviewer=<token>` is an invite link from `pp invite`: feedback left in
// this tab is attributed to that reviewer.
const params = new URLSearchParams(location.search);
const transport = new HttpTransport({
  baseUrl: params.get("host") ?? "",
  reviewerToken: params.get("reviewer") ?? undefined,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
