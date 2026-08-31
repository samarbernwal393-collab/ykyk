import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

/**
 * Persistence shim for the Claude-artifact `window.storage` API.
 * Maps get/set onto localStorage so the existing AppData layer works
 * unchanged on Vercel / static hosting. No app logic changes.
 */
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key, _secure) {
      try {
        const value = localStorage.getItem(String(key));
        if (value == null) return null;
        return { value, key: String(key) };
      } catch {
        return null;
      }
    },
    async set(key, value, _secure) {
      try {
        localStorage.setItem(String(key), String(value));
      } catch {
        /* quota / private mode — App state still holds values in memory */
      }
    },
  };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
