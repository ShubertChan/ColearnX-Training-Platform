import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import SessionStorageNotice from "./components/SessionStorageNotice";
import StepUpProvider from "./components/StepUpProvider";
import { PlatformProvider } from "./context/PlatformContext";
import { AdminInboxProvider } from "./context/AdminInboxContext";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <PlatformProvider>
        <SessionStorageNotice />
        <StepUpProvider><AdminInboxProvider><App /></AdminInboxProvider></StepUpProvider>
      </PlatformProvider>
    </HashRouter>
  </React.StrictMode>,
);
