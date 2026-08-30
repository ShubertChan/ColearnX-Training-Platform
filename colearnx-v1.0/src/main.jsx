import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { PlatformProvider } from "./context/PlatformContext";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <PlatformProvider>
        <App />
      </PlatformProvider>
    </HashRouter>
  </React.StrictMode>,
);
