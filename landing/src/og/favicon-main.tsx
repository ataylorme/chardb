import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Favicon } from "./Favicon";
import "../index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Favicon />
    </StrictMode>
);
