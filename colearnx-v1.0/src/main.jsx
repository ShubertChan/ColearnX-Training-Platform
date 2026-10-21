import React from "react";
import { LanguageEffects } from "./i18n/LanguageContext";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import SessionStorageNotice from "./components/SessionStorageNotice";
import RefundDecisionNotice from "./components/RefundDecisionNotice";
import StepUpProvider from "./components/StepUpProvider";
import { PlatformProvider } from "./context/PlatformContext";
import { AdminInboxProvider } from "./context/AdminInboxContext";
import "./styles.css";
import "./styles/language-and-pages.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LanguageEffects />
    <HashRouter>
      <PlatformProvider>
        <SessionStorageNotice />
        <StepUpProvider><AdminInboxProvider><App /><RefundDecisionNotice /></AdminInboxProvider></StepUpProvider>
      </PlatformProvider>
    </HashRouter>
  </React.StrictMode>,
);
