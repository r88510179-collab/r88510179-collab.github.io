import React from "react";
import {createRoot} from "react-dom/client";
import ConnectedApp from "./ConnectedApp.jsx";
import "./styles.css";

const root=document.getElementById("root");
if(!root)throw new Error("Missing CRM app root");
createRoot(root).render(<ConnectedApp/>);
