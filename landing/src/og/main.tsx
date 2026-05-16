import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OgImage } from "./OgImage";
import "../index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <OgImage />
    </StrictMode>
);
