import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { HttpTransport } from "./transport.ts";
import "./styles.css";

// `?host=http://other-machine:27411` points the UI at a remote host.
const params = new URLSearchParams(location.search);
const transport = new HttpTransport({ baseUrl: params.get("host") ?? "" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
