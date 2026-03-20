import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOP_N = 400; 
const CSV_PATH = path.resolve(process.cwd(), "memes.csv");
const COOKIE_PATH = path.resolve(process.cwd(), "cookies.txt");

const CSV_HEADERS = [
  "ID",
  "URLS",
  "IMAGE_URL",
  "IS_GIF",
  "TITLE",
  "MEME_TYPE",
  "KYM_SLUG",
  "MBTI_TYPES",
  "KEYWORDS",
  "TAGS",
];

function log(...args) { console.log(...args); }
function warn(...args) { console.warn(...args); }
function die(msg) { console.error(msg); process.exit(1); }

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvLine(fields) { return fields.map(csvEscape).join(","); }

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { const next = text[i+1]; if (next === '"') { field+='"'; i++; } else inQuotes=false; } 
      else field+=c;
      continue;
    }
    if (c==='\"'){inQuotes=true; continue;}
    if (c===','){row.push(field); field=""; continue;}
    if (c==='\n'){row.push(field); field=""; rows.push(row); row=[]; continue;}
    if (c==='\r') continue;
    field+=c;
  }
  if(field.length>0||row.length>0){row.push(field); rows.push(row);}
  if(rows.length===0) return {headers:[], rows:[]};
  const headers = rows[0].map(h=>String(h??"").trim());
  const data = rows.slice(1).filter(r=>r.some(x=>String(x??"").trim()!==""));
  return { headers, rows: data };
}

function toRowObject(headers,row){ const obj={}; for(let i=0;i<headers.length;i++) obj[headers[i]]=row[i]??""; return obj; }
function fromRowObject(headers,obj){ return headers.map(h=>obj[h]??""); }

async function readExistingCsv() {
  try {
    const text = await fs.readFile(CSV_PATH,"utf8");
    const parsed = parseCSV(text);
    return {
      headers: parsed.headers.length ? parsed.headers : CSV_HEADERS,
      rows: parsed.rows.map(r=>toRowObject(parsed.headers,r)),
      idSet: new Set(parsed.rows.map(r=>String(r[0]??"").trim()).filter(Boolean)),
    };
  } catch(e) {
    if(e.code==="ENOENT") return { headers:CSV_HEADERS, rows:[], idSet:new Set() };
    throw e;
  }
}

async function appendNewRows(headers, newRowObjects) {
  const lines = [];
  let existingContent="";
  try{existingContent=await fs.readFile(CSV_PATH,"utf8");}catch{}
  if(existingContent.trim()==="") lines.push(csvLine(headers));
  else lines.push(existingContent.trimEnd());
  for(const obj of newRowObjects) lines.push(csvLine(fromRowObject(headers,obj)));
  await fs.writeFile(CSV_PATH, lines.join("\n")+"\n","utf8");
}

// ---------------- Auth ----------------
async function loadCookies(){ try{ return await fs.readFile(COOKIE_PATH,"utf8"); }catch{return "";}}
async function saveCookies(cookies){ await fs.writeFile(COOKIE_PATH,cookies,"utf8");}
function extractCookies(res){ const raw = res.headers.get("set-cookie"); if(!raw) return ""; return raw.split(",").map(c=>c.split(";")[0]).join(";"); }

async function login(){
  log("Logging in...");
  const res1 = await fetch("https://imgflip.com/login",{headers:{"User-Agent":"Mozilla/5.0"}});
  let cookies = extractCookies(res1);
  const html = await res1.text();
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  if(!csrf) throw new Error("Failed to extract CSRF token");
  const res2 = await fetch("https://imgflip.com/login",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"Mozilla/5.0","Cookie":cookies},
    body:new URLSearchParams({username:process.env.IMGFLIP_USER,password:process.env.IMGFLIP_PASS,csrf_token:csrf})
  });
  const newCookies = extractCookies(res2);
  const finalCookies = [cookies,newCookies].filter(Boolean).join("; ");
  await saveCookies(finalCookies);
  log("Login complete");
  return finalCookies;
}

async function fetchWithAuth(url){
  let cookieJar = await loadCookies();
  let res = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Cookie":cookieJar}});
  let html = await res.text();
  if(html.includes("login")||html.includes("Sign Up")){
    log("Session expired → re-authenticating");
    cookieJar = await login();
    res = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Cookie":cookieJar}});
    html = await res.text();
  }
  return html;
}

// ---------------- Meme scraping ----------------
function makeBlankRow(item){
  const {id,imageUrl}=item;
  const isGif = imageUrl.toLowerCase().includes(".gif");
  const row={};
  for(const h of CSV_HEADERS) row[h]="";
  row.ID=id;
  row.URLS=`https://imgflip.com/${isGif?"gif":"i"}/${id}`;
  row.IMAGE_URL=imageUrl;
  row.IS_GIF=isGif?"TRUE":"FALSE";
  row.TITLE=id;
  return row;
}

async function fetchLatestMemeItems(){
  const url = "https://imgflip.com/all/user-images/mbtininja?sort=latest";
  try{
    const html = await fetchWithAuth(url);
    const regexes=[
      /href\s*=\s*["']?\/i\/([a-z0-9]{6,8})["'][^>]*>[\s\S]*?<img[^>]+src=["'](https:\/\/i\.imgflip\.com\/[a-z0-9]+\.(?:jpg|png|gif))["']/gi,
      /href\s*=\s*["']?\/gif\/([a-z0-9]{6,8})["']/gi // GIF-only links
    ];
    const items=[];
    const seen = new Set();
    for(const rx of regexes){
      const matches = html.matchAll(rx);
      for(const m of matches){
        const id = m[1];
        let imageUrl;
        if(m.length>2) imageUrl=m[2];
        else imageUrl=`https://i.imgflip.com/${id}.gif`;
        if(!seen.has(id)){seen.add(id); items.push({id,imageUrl});}
      }
    }
    if(items.length===0){ warn("No meme items found."); process.exit(0); }
    log(`Fetched ${items.length} items (showing first ${TOP_N})`);
    return items;
  }catch(err){ console.error("Failed to fetch Imgflip:", err.message||err); process.exit(1);}
}

// ---------------- Main ----------------
async function main(){
  const latestItems = await fetchLatestMemeItems();
  const {headers,rows:existingRows,idSet} = await readExistingCsv();
  const newItems = latestItems.filter(item=>!idSet.has(item.id));
  if(newItems.length===0){ log("No new memes found → no changes needed."); process.exit(0);}
  log(`Found ${newItems.length} new meme item(s).`);
  const newRows = newItems.map(makeBlankRow);
  await appendNewRows(headers,newRows);
  log(`Appended ${newRows.length} new row(s) to memes.csv (manual edits preserved).`);
}

main().catch(e=>die(e?.stack||e?.message||String(e)));
