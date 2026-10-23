// Connected candidate browser acceptance using fake same-origin modules only.
// Never contacts Neon, Auth, or the commercial deployment; no JWTs or credentials.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
const deps=process.env.CRM_VISUAL_DEPS;
if(!deps)throw new Error("CRM_VISUAL_DEPS required");
const {chromium}=await import(pathToFileURL(path.join(deps,"node_modules","playwright","index.mjs")).href);
const root=path.resolve("dist-connected-candidate");
const uuidA="11111111-1111-1111-1111-111111111111";
const uuidB="22222222-2222-2222-2222-222222222222";
const tenantA="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const tenantB="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const configSource="export const PLATFORM_CONFIG={mode:'live',dataUrl:'https://data.example.invalid'};";
const clientSource=String.raw