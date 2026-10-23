import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deliberately separate from the existing commercial Netlify build.
// No command can produce a deployable CRM bundle without explicitly opting into SANDBOX mode.
export default defineConfig(({command})=>{
  if(command==="build"&&process.env.CRM_SANDBOX_BUILD!=="1") {
    throw new Error("CRM release locked: only CRM_SANDBOX_BUILD=1 may build a sandbox preview.");
  }
  return {
    plugins:[react(),tailwindcss()],
    base:"./",
    build:{outDir:"dist",emptyOutDir:true},
    server:{host:"127.0.0.1",port:4174,strictPort:true},
    preview:{host:"127.0.0.1",port:4175,strictPort:true}
  };
});
