import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deliberately separate from the existing commercial Netlify build.
// No command can produce a deployable CRM bundle without explicitly opting into SANDBOX mode.
export default defineConfig(({command})=>{
  const sandbox=process.env.CRM_SANDBOX_BUILD==="1";
  const connected=process.env.CRM_CONNECTED_CANDIDATE_BUILD==="1";
  if(command==="build"&&(Number(sandbox)+Number(connected)!==1)) {
    throw new Error("CRM release locked: select exactly one explicit sandbox or connected-candidate build.");
  }
  return {
    plugins:[react(),tailwindcss()],
    base:"./",
    build:connected
      ?{outDir:"dist-connected-candidate",emptyOutDir:true,rollupOptions:{input:"connected.html"}}
      :{outDir:"dist",emptyOutDir:true},
    server:{host:"127.0.0.1",port:4174,strictPort:true},
    preview:{host:"127.0.0.1",port:4175,strictPort:true}
  };
});
