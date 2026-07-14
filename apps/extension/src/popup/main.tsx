import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@snapcrawl/shared/design/tokens.css";
import "../components/ui.css";
import { applyTheme, getTheme } from "../lib/theme";
import { App } from "./App";

applyTheme(getTheme());

const root = document.getElementById("root");
if (!root) throw new Error("SnapCrawl popup: #root element missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
