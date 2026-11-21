import React from "react";
import ReactDOM from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <IconContext.Provider value={{ weight: "duotone" }}>
        <App />
      </IconContext.Provider>
    </I18nProvider>
  </React.StrictMode>
);
