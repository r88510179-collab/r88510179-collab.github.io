// CI-only visual verification of the DISCONNECTED commissioner CRM demo.
// No remote deployment or credentials; serves only the standalone Vite bundle.
// Runtime dependency (Playwright) is installed in a temporary CI directory.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

const prefix=process.env.CRM_VISUAL_DEPS;
if(!prefix)throw new Error("CRM_VISUAL_DEPS must point to an isolated Playwright install");
const {chromium}=await import(pathToFileURL(path.join(prefix,"node_modules","playwright","index.mjs")).href);
const root=path.resolve("dist");
const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml"};
const server=http.createServer(async (req,res)=>{
  try {
    const raw=new URL(req.url,"http://127.0.0.1").pathname;
    if(raw.includes("..")||!/^\/(?:assets\/[a-zA-Z0-9._-]+|index\.html)?$/.test(raw)){
      res.writeHead(404);res.end();return;
    }
    const file=path.join(root,raw==="/"?"/index.html":raw);
    const body=await fs.readFile(file);
    res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});
    res.end(body);
  } catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();
if(!address||typeof address==="string")throw new Error("No loopback server");
const url="http://127.0.0.1:"+address.port;
const cases=[
  {width:360,height:780,tabs:["Home","Players","Picks","Settings","Dues"]},
  {width:412,height:915,tabs:["Home","Settings","Dues"]},
  {width:1440,height:900,tabs:["Home","Players","Picks","Settings","Dues"]}
];
let browser=null,checks=0;
try{
  const browserPaths=["/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium"];
  let browserPath=null;
  for(const candidate of browserPaths){
    try{await fs.access(candidate);browserPath=candidate;break;}catch{}
  }
  if(!browserPath)throw new Error("No system Chrome/Chromium browser available for viewport QA");
  browser=await chromium.launch({headless:true,executablePath:browserPath,args:["--no-sandbox"]});
  await fs.mkdir("visual-evidence",{recursive:true});
  for(const c of cases){
    const page=await browser.newPage({viewport:{width:c.width,height:c.height},deviceScaleFactor:1,reducedMotion:"reduce"});
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
    await page.goto(url,{waitUntil:"networkidle"});
    await page.getByRole("heading",{name:"Commissioner Home"}).waitFor();
    for(const tab of c.tabs){
      const nav=c.width<=720?page.getByRole("navigation",{name:"Mobile commissioner navigation"}):page.getByRole("navigation",{name:"Commissioner navigation"});
      await nav.getByRole("button",{name:tab,exact:true}).click();
      await page.waitForTimeout(75);
      const sizes=await page.evaluate(()=>({
        scrollWidth:document.documentElement.scrollWidth,
        clientWidth:document.documentElement.clientWidth,
        bodyScroll:document.body.scrollWidth,
        viewport:window.innerWidth
      }));
      if(sizes.scrollWidth>c.width+1||sizes.bodyScroll>c.width+1){
        throw new Error(c.width+"px "+tab+": horizontal overflow "+JSON.stringify(sizes));
      }
      if(errors.length)throw new Error(c.width+"px "+tab+": runtime errors: "+errors.join(" | "));
      const slug=tab.toLowerCase();
      if((c.width===360||c.width===1440)&&(["Home","Settings","Dues"].includes(tab))){
        await page.screenshot({path:"visual-evidence/crm-"+c.width+"-"+slug+".png",fullPage:true});
      }
      checks++;
    }
    if(c.width===360){
      const nav=page.getByRole("navigation",{name:"Mobile commissioner navigation"});
      await nav.getByRole("button",{name:"Settings"}).click();
      await page.getByRole("heading",{name:"Assistant commissioner access"}).waitFor();
      await page.getByRole("textbox",{name:"Assistant's verified email"}).fill("helper@example.com");
      await page.getByRole("button",{name:"Add assistant"}).click();
      await page.getByText("Saved in this demo only.",{exact:false}).waitFor();
      checks++;
    }
    await page.close();
  }
  console.log("CRM disconnected-browser visual checks PASSED: "+checks+" cases; 360/412/1440px; no horizontal overflow or page errors.");
}finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
