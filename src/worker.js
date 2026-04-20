/**
 * VCF → CSV Converter — Cloudflare Worker (all-in-one)
 * GET  /         → HTML UI
 * POST /convert  → { success, csv, stats }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

addEventListener("fetch", (e) => e.respondWith(route(e.request)));

async function route(req) {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "POST" && pathname === "/convert") return handleConvert(req);
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html"))
    return new Response(getHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  return new Response("Not Found", { status: 404 });
}

// ─── VCF Parser ───────────────────────────────────────────────────────────────

function prm(ps, n) {
  if (!ps) return "";
  const m = ps.match(new RegExp(`(?:^|;)${n}=([^;]*)`, "i"));
  return m ? m[1].replace(/"/g, "") : "";
}

function dqp(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseVCF(text) {
  return text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split(/BEGIN:VCARD/i)
    .filter(b => b.trim())
    .map(b => parseCard("BEGIN:VCARD\n" + b))
    .filter(Boolean);
}

function parseCard(block) {
  const lines = block.split("\n").filter(l => l.trim());
  if (!lines.some(l => /^BEGIN:VCARD/i.test(l))) return null;
  const c = {
    firstName:"",lastName:"",middleName:"",prefix:"",suffix:"",formattedName:"",nickname:"",
    organization:"",department:"",title:"",role:"",
    phone1:"",phone1Type:"",phone2:"",phone2Type:"",phone3:"",phone3Type:"",
    phone4:"",phone4Type:"",phone5:"",phone5Type:"",
    email1:"",email1Type:"",email2:"",email2Type:"",email3:"",email3Type:"",
    homeStreet:"",homeCity:"",homeState:"",homePostal:"",homeCountry:"",
    workStreet:"",workCity:"",workState:"",workPostal:"",workCountry:"",
    url:"",xTwitter:"",xFacebook:"",xLinkedIn:"",xInstagram:"",
    birthday:"",anniversary:"",note:"",categories:"",uid:"",rev:""
  };
  const phones = [], emails = [];

  for (const raw of lines) {
    const ci = raw.indexOf(":");
    if (ci === -1) continue;
    const pf = raw.substring(0, ci).toUpperCase();
    let v = raw.substring(ci + 1).trim();
    const si = pf.indexOf(";");
    const pr = si !== -1 ? pf.substring(0, si) : pf;
    const ps = si !== -1 ? pf.substring(si + 1) : "";
    if (prm(ps, "ENCODING").toUpperCase() === "QUOTED-PRINTABLE") v = dqp(v);
    v = v.replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\n/gi," ").replace(/\\\\/g,"\\");

    switch (pr) {
      case "FN":   c.formattedName = v; break;
      case "N": {
        const p = v.split(";");
        c.lastName=(p[0]||"").trim(); c.firstName=(p[1]||"").trim();
        c.middleName=(p[2]||"").trim(); c.prefix=(p[3]||"").trim(); c.suffix=(p[4]||"").trim(); break;
      }
      case "NICKNAME": c.nickname = v; break;
      case "ORG": {
        const p = v.split(";");
        c.organization=(p[0]||"").trim(); c.department=(p[1]||"").trim(); break;
      }
      case "TITLE":  c.title = v; break;
      case "ROLE":   c.role  = v; break;
      case "TEL":    phones.push({ value: v, type: prm(ps,"TYPE") }); break;
      case "EMAIL":  emails.push({ value: v, type: prm(ps,"TYPE") }); break;
      case "ADR": {
        const p = v.split(";");
        const st=p[2]||"",ci2=p[3]||"",sta=p[4]||"",po=p[5]||"",co=p[6]||"";
        if ((prm(ps,"TYPE")||"").toUpperCase().includes("WORK")) {
          c.workStreet=st.trim(); c.workCity=ci2.trim(); c.workState=sta.trim(); c.workPostal=po.trim(); c.workCountry=co.trim();
        } else if (!c.homeStreet) {
          c.homeStreet=st.trim(); c.homeCity=ci2.trim(); c.homeState=sta.trim(); c.homePostal=po.trim(); c.homeCountry=co.trim();
        }
        break;
      }
      case "URL":         if (!c.url) c.url = v; break;
      case "BDAY":        c.birthday    = v.replace(/^--/,""); break;
      case "ANNIVERSARY": c.anniversary = v; break;
      case "NOTE":        c.note        = v; break;
      case "UID":         c.uid         = v; break;
      case "CATEGORIES":  c.categories  = v; break;
      case "REV":         c.rev         = v; break;
      case "X-TWITTER":   c.xTwitter    = v; break;
      case "X-FACEBOOK":  c.xFacebook   = v; break;
      case "X-LINKEDIN":  c.xLinkedIn   = v; break;
      case "X-INSTAGRAM": c.xInstagram  = v; break;
      case "X-SOCIALPROFILE": {
        const t = (prm(ps,"TYPE")||"").toLowerCase();
        if (t==="twitter") c.xTwitter=v;
        else if (t==="facebook") c.xFacebook=v;
        else if (t==="linkedin") c.xLinkedIn=v;
        else if (t==="instagram") c.xInstagram=v;
        break;
      }
    }
  }
  phones.slice(0,5).forEach((p,i)=>{ c[`phone${i+1}`]=p.value; c[`phone${i+1}Type`]=p.type; });
  emails.slice(0,3).forEach((e,i)=>{ c[`email${i+1}`]=e.value; c[`email${i+1}Type`]=e.type; });
  return c;
}

// ─── CSV Builder ──────────────────────────────────────────────────────────────

const HEADERS = [
  "First Name","Last Name","Middle Name","Prefix","Suffix","Formatted Name","Nickname",
  "Organization","Department","Title","Role",
  "Phone 1","Phone 1 Type","Phone 2","Phone 2 Type","Phone 3","Phone 3 Type",
  "Phone 4","Phone 4 Type","Phone 5","Phone 5 Type",
  "Email 1","Email 1 Type","Email 2","Email 2 Type","Email 3","Email 3 Type",
  "Home Street","Home City","Home State","Home Postal","Home Country",
  "Work Street","Work City","Work State","Work Postal","Work Country",
  "URL","Twitter/X","Facebook","LinkedIn","Instagram",
  "Birthday","Anniversary","Note","Categories","UID","Rev"
];

const KEYS = [
  "firstName","lastName","middleName","prefix","suffix","formattedName","nickname",
  "organization","department","title","role",
  "phone1","phone1Type","phone2","phone2Type","phone3","phone3Type",
  "phone4","phone4Type","phone5","phone5Type",
  "email1","email1Type","email2","email2Type","email3","email3Type",
  "homeStreet","homeCity","homeState","homePostal","homeCountry",
  "workStreet","workCity","workState","workPostal","workCountry",
  "url","xTwitter","xFacebook","xLinkedIn","xInstagram",
  "birthday","anniversary","note","categories","uid","rev"
];

function esc(v) {
  const s = String(v ?? "");
  return (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes(";"))
    ? `"${s.replace(/"/g,'""')}"` : s;
}

function toCSV(contacts) {
  return [HEADERS.map(esc).join(","), ...contacts.map(c => KEYS.map(k => esc(c[k]||"")).join(","))].join("\r\n");
}

// ─── API Handler ──────────────────────────────────────────────────────────────

async function handleConvert(req) {
  try {
    const ct = req.headers.get("content-type") || "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const file = fd.get("vcf");
      if (!file) return jerr("No file. Expected field: vcf", 400);
      text = await file.text();
    } else {
      text = await req.text();
      if (ct.includes("application/json")) {
        try { const b = JSON.parse(text); text = b.vcf || b.content || ""; } catch {}
      }
    }
    if (!text.trim()) return jerr("Empty VCF content", 400);
    const contacts = parseVCF(text);
    if (!contacts.length) return jerr("No valid vCard records found", 422);
    const csv = toCSV(contacts);
    const stats = {
      total:     contacts.length,
      withPhone: contacts.filter(c => c.phone1).length,
      withEmail: contacts.filter(c => c.email1).length,
      withOrg:   contacts.filter(c => c.organization).length,
    };
    return new Response(JSON.stringify({ success: true, csv, stats }), {
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    return jerr("Server error: " + e.message, 500);
  }
}

function jerr(msg, status) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" }
  });
}

// ─── Embedded HTML ────────────────────────────────────────────────────────────

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>VCF to CSV — Contacts Converter</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --blue:#0071e3;--blue-h:#0077ed;--green:#34c759;--red:#ff3b30;--orange:#ff9500;
  --bg:#f5f5f7;--card:#fff;--card2:#fbfbfd;
  --border:rgba(0,0,0,.08);
  --sh:0 2px 20px rgba(0,0,0,.06),0 0 0 1px rgba(0,0,0,.04);
  --sh-h:0 8px 40px rgba(0,0,0,.12),0 0 0 1px rgba(0,0,0,.05);
  --t1:#1d1d1f;--t2:#424245;--t3:#6e6e73;--t4:#aeaeb2;
  --r:18px;--rs:10px;
  --f:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif
}
@media(prefers-color-scheme:dark){:root{
  --bg:#000;--card:#1c1c1e;--card2:#2c2c2e;
  --border:rgba(255,255,255,.10);
  --sh:0 2px 20px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06);
  --sh-h:0 8px 40px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);
  --t1:#f5f5f7;--t2:#d1d1d6;--t3:#8e8e93;--t4:#48484a
}}
html{scroll-behavior:smooth}
body{font-family:var(--f);background:var(--bg);color:var(--t1);-webkit-font-smoothing:antialiased;min-height:100vh}
nav{position:sticky;top:0;z-index:100;background:rgba(245,245,247,.85);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--border)}
@media(prefers-color-scheme:dark){nav{background:rgba(0,0,0,.85)}}
.ni{max-width:980px;margin:0 auto;padding:0 22px;height:48px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.nl{display:flex;align-items:center;gap:8px;text-decoration:none;font-size:17px;font-weight:600;color:var(--t1);letter-spacing:-.3px}
.nl svg{width:20px;height:20px}
.nr{display:flex;align-items:center;gap:28px;list-style:none}
.nr a,.nx{font-size:13px;color:var(--t3);text-decoration:none;transition:color .2s;display:flex;align-items:center;gap:5px}
.nr a:hover,.nx:hover{color:var(--t1)}
.nx svg{width:14px;height:14px}
.hero{text-align:center;padding:100px 22px 60px;max-width:700px;margin:0 auto}
.hb{display:inline-flex;align-items:center;gap:6px;background:rgba(0,113,227,.08);color:var(--blue);font-size:12px;font-weight:600;padding:5px 12px;border-radius:100px;margin-bottom:22px;letter-spacing:.3px;text-transform:uppercase}
@media(prefers-color-scheme:dark){.hb{background:rgba(0,113,227,.18)}}
.hero h1{font-size:clamp(36px,6vw,56px);font-weight:700;letter-spacing:-1.5px;line-height:1.07;margin-bottom:18px}
.hero h1 span{color:var(--blue)}
.hero p{font-size:19px;color:var(--t3);line-height:1.55;max-width:500px;margin:0 auto}
.ct{max-width:860px;margin:0 auto;padding:0 22px 80px}
.uc{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);padding:48px 40px;text-align:center;transition:box-shadow .3s}
.uc:hover{box-shadow:var(--sh-h)}
.dz{border:2px dashed var(--border);border-radius:var(--rs);padding:52px 32px;cursor:pointer;transition:all .25s}
.dz:hover,.dz.on{border-color:var(--blue);background:rgba(0,113,227,.04)}
.dz.on{transform:scale(1.005)}
@media(prefers-color-scheme:dark){.dz:hover,.dz.on{background:rgba(0,113,227,.08)}}
.di{width:64px;height:64px;background:linear-gradient(145deg,#e8f0fe,#d2e3fc);border-radius:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;transition:transform .25s}
@media(prefers-color-scheme:dark){.di{background:linear-gradient(145deg,#1a2744,#162040)}}
.dz:hover .di{transform:translateY(-3px)}
.di svg{width:28px;height:28px;color:var(--blue)}
.dz h3{font-size:19px;font-weight:600;margin-bottom:8px;letter-spacing:-.3px}
.dz p{font-size:14px;color:var(--t3);margin-bottom:22px}
#fi{display:none}
.bp{display:inline-flex;align-items:center;gap:8px;background:var(--blue);color:#fff;font-family:var(--f);font-size:15px;font-weight:600;padding:12px 24px;border-radius:100px;border:none;cursor:pointer;transition:all .2s;letter-spacing:-.2px}
.bp:hover{background:var(--blue-h);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,113,227,.35)}
.bp:active{transform:translateY(0)}
.bp svg{width:16px;height:16px}
.bs{display:inline-flex;align-items:center;gap:8px;background:var(--card2);color:var(--t2);font-family:var(--f);font-size:15px;font-weight:500;padding:11px 22px;border-radius:100px;border:1px solid var(--border);cursor:pointer;transition:all .2s;letter-spacing:-.2px}
.bs:hover{background:var(--card);border-color:rgba(0,0,0,.15);transform:translateY(-1px)}
@media(prefers-color-scheme:dark){.bs{background:#2c2c2e}.bs:hover{background:#3a3a3c;border-color:rgba(255,255,255,.2)}}
.fn{margin-top:16px;font-size:14px;color:var(--blue);font-weight:500;min-height:20px}
.cr{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:28px;flex-wrap:wrap}
.sb{display:none;align-items:center;gap:12px;margin-top:28px;padding:14px 18px;background:var(--card2);border-radius:var(--rs);border:1px solid var(--border)}
.sb.on{display:flex}
.sp{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.st{font-size:14px;color:var(--t3)}
.eb{display:none;align-items:flex-start;gap:12px;margin-top:20px;padding:14px 18px;background:rgba(255,59,48,.06);border:1px solid rgba(255,59,48,.2);border-radius:var(--rs)}
.eb.on{display:flex}
.eb svg{flex-shrink:0;color:var(--red);width:18px;height:18px;margin-top:1px}
.em{font-size:14px;color:var(--red);line-height:1.5}
.rs{display:none;margin-top:32px;animation:fu .4s ease both}
.rs.on{display:block}
@keyframes fu{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.sr{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.sc{background:var(--card);border-radius:var(--rs);box-shadow:var(--sh);padding:20px 18px;text-align:center}
.sn{font-size:32px;font-weight:700;letter-spacing:-1px;color:var(--blue);display:block;line-height:1;margin-bottom:6px}
.sl{font-size:12px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
.tc{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
.th{padding:18px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:12px}
.th h3{font-size:15px;font-weight:600;letter-spacing:-.2px}
.ta{display:flex;gap:8px}
.ts{overflow-x:auto;max-height:480px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead{position:sticky;top:0;z-index:2}
thead tr{background:var(--card2)}
@media(prefers-color-scheme:dark){thead tr{background:#2c2c2e}}
th{padding:11px 16px;text-align:left;font-weight:600;color:var(--t3);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 16px;color:var(--t2);border-bottom:1px solid var(--border);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(0,113,227,.03)}
@media(prefers-color-scheme:dark){tbody tr:hover{background:rgba(0,113,227,.06)}}
.fts{margin-top:60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.ft{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);padding:28px 24px;transition:box-shadow .3s,transform .3s}
.ft:hover{box-shadow:var(--sh-h);transform:translateY(-2px)}
.fi{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.fi svg{width:22px;height:22px}
.ft h4{font-size:15px;font-weight:600;letter-spacing:-.2px;margin-bottom:6px}
.ft p{font-size:13px;color:var(--t3);line-height:1.55}
footer{border-top:1px solid var(--border);padding:32px 22px;text-align:center}
.fo{max-width:860px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:12px}
.fl{display:flex;align-items:center;gap:20px;flex-wrap:wrap;justify-content:center}
.fl a{font-size:13px;color:var(--t3);text-decoration:none;display:flex;align-items:center;gap:5px;transition:color .2s}
.fl a:hover{color:var(--t1)}
.fl svg{width:14px;height:14px}
footer p{font-size:12px;color:var(--t4)}
@media(max-width:600px){.uc{padding:28px 20px}.hero{padding:70px 22px 40px}.th{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<nav>
  <div class="ni">
    <a class="nl" href="/">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
      </svg>VCF Converter
    </a>
    <ul class="nr">
      <li><a href="#cv">Converter</a></li>
      <li><a href="#ft">Features</a></li>
      <li>
        <a class="nx" href="https://www.threads.com/@..." target="_blank" rel="noopener">
          <svg viewBox="0 0 192 192" fill="currentColor"><path d="M141.537 88.988a66 66 0 0 0-2.518-1.143c-1.482-27.307-16.403-42.94-41.457-43.1h-.34c-14.986 0-27.449 6.396-35.12 18.036l13.779 9.452c5.73-8.695 14.724-10.548 21.348-10.548h.232c8.25.053 14.476 2.452 18.502 7.129 2.932 3.405 4.893 8.111 5.864 14.05-7.314-1.243-15.224-1.626-23.68-1.14-23.82 1.371-39.134 15.264-38.105 34.568.522 9.792 5.4 18.216 13.735 23.719 7.047 4.652 16.124 6.927 25.557 6.412 12.458-.683 22.231-5.436 29.049-14.127 5.178-6.6 8.453-15.153 9.899-25.93 5.937 3.583 10.337 8.298 12.767 13.966 4.132 9.635 4.373 25.468-8.546 38.376-11.319 11.308-24.925 16.2-45.488 16.35-22.809-.169-40.06-7.484-51.275-21.742C35.236 139.966 29.808 120.682 29.605 96c.203-24.682 5.63-43.966 16.133-57.317C56.954 24.425 74.204 17.11 97.013 16.94c22.975.17 40.526 7.52 52.171 21.847 5.71 7.026 10.015 15.86 12.853 26.162l16.147-4.308c-3.44-12.68-8.853-23.606-16.219-32.668C147.036 10.802 125.202 1.203 97.07 1L96.93 1C68.89 1.203 47.318 10.832 32.788 28.571 19.882 44.454 13.226 66.956 13.001 96c.225 29.044 6.88 51.547 19.787 67.429C47.317 181.168 68.89 190.797 96.93 191h.14c25.17-.173 43.02-6.768 57.603-21.334 19.284-19.264 18.688-43.337 12.328-58.104-4.547-10.595-13.232-19.178-25.464-23.574Zm-44.47 42.155c-10.434.572-21.286-4.095-21.82-14.078-.4-7.514 5.35-15.913 22.558-16.916 1.976-.114 3.917-.168 5.825-.168 6.072 0 11.76.557 16.95 1.594-1.927 24.048-13.58 28.952-23.513 29.568Z"/></svg>
          @...
        </a>
      </li>
    </ul>
  </div>
</nav>
<section class="hero">
  <div class="hb">
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="5"/></svg>
    Files never leave your browser
  </div>
  <h1>Convert <span>VCF</span> contacts<br>to clean CSV</h1>
  <p>Upload any .vcf file — all fields, structured into rows. Works entirely in your browser.</p>
</section>
<main class="ct" id="cv">
  <div class="uc">
    <div class="dz" id="dz">
      <div class="di">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
      </div>
      <h3>Drop your VCF file here</h3>
      <p>Supports vCard 2.1, 3.0 and 4.0 &middot; Multi-contact files</p>
      <input type="file" id="fi" accept=".vcf,text/vcard,text/x-vcard" multiple/>
      <button class="bp" onclick="document.getElementById('fi').click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
        </svg>Choose File
      </button>
    </div>
    <div class="fn" id="fn"></div>
    <div class="cr">
      <button class="bp" onclick="run()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
          <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
        </svg>Convert to CSV
      </button>
    </div>
    <div class="sb" id="sb"><div class="sp"></div><span class="st" id="st">Processing…</span></div>
    <div class="eb" id="eb">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="em" id="em"></span>
    </div>
  </div>
  <div class="rs" id="rs">
    <div class="sr" id="sr"></div>
    <div class="tc">
      <div class="th">
        <h3 id="tt">Converted Contacts</h3>
        <div class="ta">
          <button class="bs" id="cb" onclick="copyCSV()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>Copy CSV
          </button>
          <button class="bp" onclick="dlCSV()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>Download CSV
          </button>
        </div>
      </div>
      <div class="ts"><table id="tbl"></table></div>
    </div>
  </div>
  <div class="fts" id="ft">
    <div class="ft"><div class="fi" style="background:rgba(0,113,227,.1)"><svg style="color:var(--blue)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><h4>All vCard Fields</h4><p>Names, phones, emails, addresses, organizations, URLs, social profiles, birthdays and more.</p></div>
    <div class="ft"><div class="fi" style="background:rgba(52,199,89,.1)"><svg style="color:var(--green)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><h4>100% Private</h4><p>Browser-side parsing — files never leave your device. No server, no tracking.</p></div>
    <div class="ft"><div class="fi" style="background:rgba(255,149,0,.1)"><svg style="color:var(--orange)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div><h4>Worker API</h4><p>POST /convert — accepts multipart VCF, returns structured JSON with CSV and stats.</p></div>
    <div class="ft"><div class="fi" style="background:rgba(88,86,214,.1)"><svg style="color:#5856d6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg></div><h4>vCard 2.1 / 3.0 / 4.0</h4><p>Handles Quoted-Printable encoding, line unfolding, multi-value fields and UTF-8.</p></div>
  </div>
</main>
<footer>
  <div class="fo">
    <div class="fl">
      <a href="https://www.threads.com/@..." target="_blank" rel="noopener">
        <svg viewBox="0 0 192 192" fill="currentColor"><path d="M141.537 88.988a66 66 0 0 0-2.518-1.143c-1.482-27.307-16.403-42.94-41.457-43.1h-.34c-14.986 0-27.449 6.396-35.12 18.036l13.779 9.452c5.73-8.695 14.724-10.548 21.348-10.548h.232c8.25.053 14.476 2.452 18.502 7.129 2.932 3.405 4.893 8.111 5.864 14.05-7.314-1.243-15.224-1.626-23.68-1.14-23.82 1.371-39.134 15.264-38.105 34.568.522 9.792 5.4 18.216 13.735 23.719 7.047 4.652 16.124 6.927 25.557 6.412 12.458-.683 22.231-5.436 29.049-14.127 5.178-6.6 8.453-15.153 9.899-25.93 5.937 3.583 10.337 8.298 12.767 13.966 4.132 9.635 4.373 25.468-8.546 38.376-11.319 11.308-24.925 16.2-45.488 16.35-22.809-.169-40.06-7.484-51.275-21.742C35.236 139.966 29.808 120.682 29.605 96c.203-24.682 5.63-43.966 16.133-57.317C56.954 24.425 74.204 17.11 97.013 16.94c22.975.17 40.526 7.52 52.171 21.847 5.71 7.026 10.015 15.86 12.853 26.162l16.147-4.308c-3.44-12.68-8.853-23.606-16.219-32.668C147.036 10.802 125.202 1.203 97.07 1L96.93 1C68.89 1.203 47.318 10.832 32.788 28.571 19.882 44.454 13.226 66.956 13.001 96c.225 29.044 6.88 51.547 19.787 67.429C47.317 181.168 68.89 190.797 96.93 191h.14c25.17-.173 43.02-6.768 57.603-21.334 19.284-19.264 18.688-43.337 12.328-58.104-4.547-10.595-13.232-19.178-25.464-23.574Zm-44.47 42.155c-10.434.572-21.286-4.095-21.82-14.078-.4-7.514 5.35-15.913 22.558-16.916 1.976-.114 3.917-.168 5.825-.168 6.072 0 11.76.557 16.95 1.594-1.927 24.048-13.58 28.952-23.513 29.568Z"/></svg>
        @... on Threads
      </a>
      <span style="color:var(--t4);font-size:13px">Made with &#9825; in Ukraine</span>
    </div>
    <p>VCF Converter &mdash; no tracking, no ads.</p>
  </div>
</footer>
<script>
const H=["First Name","Last Name","Middle Name","Prefix","Suffix","Formatted Name","Nickname","Organization","Department","Title","Role","Phone 1","Phone 1 Type","Phone 2","Phone 2 Type","Phone 3","Phone 3 Type","Phone 4","Phone 4 Type","Phone 5","Phone 5 Type","Email 1","Email 1 Type","Email 2","Email 2 Type","Email 3","Email 3 Type","Home Street","Home City","Home State","Home Postal","Home Country","Work Street","Work City","Work State","Work Postal","Work Country","URL","Twitter/X","Facebook","LinkedIn","Instagram","Birthday","Anniversary","Note","Categories","UID","Rev"];
const K=["firstName","lastName","middleName","prefix","suffix","formattedName","nickname","organization","department","title","role","phone1","phone1Type","phone2","phone2Type","phone3","phone3Type","phone4","phone4Type","phone5","phone5Type","email1","email1Type","email2","email2Type","email3","email3Type","homeStreet","homeCity","homeState","homePostal","homeCountry","workStreet","workCity","workState","workPostal","workCountry","url","xTwitter","xFacebook","xLinkedIn","xInstagram","birthday","anniversary","note","categories","uid","rev"];
let csv="",fn="contacts";
const $=id=>document.getElementById(id);
const dz=$("dz"),fi=$("fi");
dz.addEventListener("dragover",e=>{e.preventDefault();dz.classList.add("on")});
dz.addEventListener("dragleave",()=>dz.classList.remove("on"));
dz.addEventListener("drop",e=>{e.preventDefault();dz.classList.remove("on");if(e.dataTransfer.files.length)setF(e.dataTransfer.files)});
fi.addEventListener("change",()=>fi.files.length&&setF(fi.files));
function setF(fs){$("fn").textContent=Array.from(fs).map(f=>f.name).join(", ");fn=fs[0].name.replace(/\\.vcf$/i,"")}
function prm(ps,n){if(!ps)return"";const m=ps.match(new RegExp("(?:^|;)"+n+"=([^;]*)","i"));return m?m[1].replace(/"/g,""):""}
function dqp(s){return s.replace(/=\\r?\\n/g,"").replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))}
function parseVCF(t){return t.replace(/\\r\\n/g,"\\n").replace(/\\r/g,"\\n").replace(/\\n[ \\t]/g,"").split(/BEGIN:VCARD/i).filter(b=>b.trim()).map(b=>parseCard("BEGIN:VCARD\\n"+b)).filter(Boolean)}
function parseCard(block){
  const lines=block.split("\\n").filter(l=>l.trim());
  if(!lines.some(l=>/^BEGIN:VCARD/i.test(l)))return null;
  const c={firstName:"",lastName:"",middleName:"",prefix:"",suffix:"",formattedName:"",nickname:"",organization:"",department:"",title:"",role:"",phone1:"",phone1Type:"",phone2:"",phone2Type:"",phone3:"",phone3Type:"",phone4:"",phone4Type:"",phone5:"",phone5Type:"",email1:"",email1Type:"",email2:"",email2Type:"",email3:"",email3Type:"",homeStreet:"",homeCity:"",homeState:"",homePostal:"",homeCountry:"",workStreet:"",workCity:"",workState:"",workPostal:"",workCountry:"",url:"",xTwitter:"",xFacebook:"",xLinkedIn:"",xInstagram:"",birthday:"",anniversary:"",note:"",categories:"",uid:"",rev:""};
  const phones=[],emails=[];
  for(const raw of lines){
    const ci=raw.indexOf(":");if(ci===-1)continue;
    const pf=raw.substring(0,ci).toUpperCase();
    let v=raw.substring(ci+1).trim();
    const si=pf.indexOf(";"),pr=si!==-1?pf.substring(0,si):pf,ps=si!==-1?pf.substring(si+1):"";
    if(prm(ps,"ENCODING").toUpperCase()==="QUOTED-PRINTABLE")v=dqp(v);
    v=v.replace(/\\\\,/g,",").replace(/\\\\;/g,";").replace(/\\\\n/gi," ").replace(/\\\\\\\\/g,"\\\\");
    switch(pr){
      case"FN":c.formattedName=v;break;
      case"N":{const p=v.split(";");c.lastName=(p[0]||"").trim();c.firstName=(p[1]||"").trim();c.middleName=(p[2]||"").trim();c.prefix=(p[3]||"").trim();c.suffix=(p[4]||"").trim();break}
      case"NICKNAME":c.nickname=v;break;
      case"ORG":{const p=v.split(";");c.organization=(p[0]||"").trim();c.department=(p[1]||"").trim();break}
      case"TITLE":c.title=v;break;case"ROLE":c.role=v;break;
      case"TEL":phones.push({value:v,type:prm(ps,"TYPE")});break;
      case"EMAIL":emails.push({value:v,type:prm(ps,"TYPE")});break;
      case"ADR":{const p=v.split(";");const st=p[2]||"",ct=p[3]||"",sta=p[4]||"",po=p[5]||"",co=p[6]||"";
        if((prm(ps,"TYPE")||"").toUpperCase().includes("WORK")){c.workStreet=st.trim();c.workCity=ct.trim();c.workState=sta.trim();c.workPostal=po.trim();c.workCountry=co.trim()}
        else if(!c.homeStreet){c.homeStreet=st.trim();c.homeCity=ct.trim();c.homeState=sta.trim();c.homePostal=po.trim();c.homeCountry=co.trim()}break}
      case"URL":if(!c.url)c.url=v;break;
      case"BDAY":c.birthday=v.replace(/^--/,"");break;
      case"ANNIVERSARY":c.anniversary=v;break;
      case"NOTE":c.note=v;break;case"UID":c.uid=v;break;case"CATEGORIES":c.categories=v;break;case"REV":c.rev=v;break;
      case"X-TWITTER":c.xTwitter=v;break;case"X-FACEBOOK":c.xFacebook=v;break;case"X-LINKEDIN":c.xLinkedIn=v;break;case"X-INSTAGRAM":c.xInstagram=v;break;
      case"X-SOCIALPROFILE":{const t=(prm(ps,"TYPE")||"").toLowerCase();if(t==="twitter")c.xTwitter=v;else if(t==="facebook")c.xFacebook=v;else if(t==="linkedin")c.xLinkedIn=v;else if(t==="instagram")c.xInstagram=v;break}
    }
  }
  phones.slice(0,5).forEach((p,i)=>{c["phone"+(i+1)]=p.value;c["phone"+(i+1)+"Type"]=p.type});
  emails.slice(0,3).forEach((e,i)=>{c["email"+(i+1)]=e.value;c["email"+(i+1)+"Type"]=e.type});
  return c;
}
function esc(v){const s=String(v??"");return(s.includes('"')||s.includes(",")||s.includes("\\n")||s.includes(";"))?'"'+s.replace(/"/g,'""')+'"':s}
function toCSV(cs){return[H.map(esc).join(","),...cs.map(c=>K.map(k=>esc(c[k]||"")).join(","))].join("\\r\\n")}
async function run(){
  if(!fi.files.length){showE("Please select a .vcf file first.");return}
  hideE();showS("Reading file…");
  try{
    let all=[];
    for(const f of fi.files){showS("Parsing "+f.name+"…");const t=await f.text();all=all.concat(parseVCF(t))}
    if(!all.length)throw new Error("No valid vCard records found");
    csv=toCSV(all);
    const s={total:all.length,withPhone:all.filter(c=>c.phone1).length,withEmail:all.filter(c=>c.email1).length,withOrg:all.filter(c=>c.organization).length};
    hideS();showR(all,s);
  }catch(e){hideS();showE(e.message)}
}
function showS(m){$("st").textContent=m;$("sb").classList.add("on")}
function hideS(){$("sb").classList.remove("on")}
function showE(m){$("em").textContent=m;$("eb").classList.add("on")}
function hideE(){$("eb").classList.remove("on")}
function h(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function showR(contacts,stats){
  $("rs").classList.add("on");
  $("tt").textContent=stats.total+" Contact"+(stats.total!==1?"s":"")+" Converted";
  $("sr").innerHTML=[{n:stats.total,l:"Contacts"},{n:stats.withPhone,l:"With Phone"},{n:stats.withEmail,l:"With Email"},{n:stats.withOrg,l:"With Org"}]
    .map(s=>'<div class="sc"><span class="sn">'+s.n+'</span><span class="sl">'+s.l+'</span></div>').join("");
  const pk=K.filter(k=>contacts.some(c=>c[k]));
  const ph=pk.map(k=>H[K.indexOf(k)]);
  $("tbl").innerHTML="<thead><tr>"+ph.map(x=>"<th>"+x+"</th>").join("")+"</tr></thead><tbody>"+
    contacts.slice(0,200).map(c=>"<tr>"+pk.map(k=>"<td>"+h(c[k])+"</td>").join("")+"</tr>").join("")+
    (contacts.length>200?'<tr><td colspan="'+pk.length+'" style="text-align:center;color:var(--t3);font-style:italic;padding:16px">&hellip; and '+(contacts.length-200)+' more &mdash; download CSV for full data</td></tr>':"")+
    "</tbody>";
  $("rs").scrollIntoView({behavior:"smooth",block:"start"});
}
function dlCSV(){if(!csv)return;const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"}));a.download=fn+".csv";a.click()}
async function copyCSV(){
  if(!csv)return;
  await navigator.clipboard.writeText(csv);
  const b=$("cb"),o=b.innerHTML;
  b.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
  b.style.color="var(--green)";setTimeout(()=>{b.innerHTML=o;b.style.color=""},2000);
}
</script>
</body>
</html>`;
}
