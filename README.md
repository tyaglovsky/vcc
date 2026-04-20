# VCF Converter

A Cloudflare Worker that converts VCF/vCard contact files to clean CSV — entirely in your browser.

**Live:** [vcc.aeneid.win](https://vcc.aeneid.win)

## Features

- **100% private** — files are parsed client-side, never uploaded to a server
- **All vCard fields** — names, phones, emails, addresses, organizations, social profiles, birthdays, and more
- **vCard 2.1, 3.0 and 4.0** — handles Quoted-Printable encoding, line unfolding, multi-value fields, and UTF-8
- **Multi-contact files** — batch convert any number of contacts in a single `.vcf` file
- **Worker API** — `POST /convert` accepts multipart VCF, returns structured JSON with CSV and stats

## API

```
POST /convert
Content-Type: multipart/form-data

Field: vcf — the .vcf file
```

Response:

```json
{
  "success": true,
  "csv": "First Name,Last Name,...\n...",
  "stats": {
    "total": 42,
    "withPhone": 38,
    "withEmail": 31,
    "withOrg": 20
  }
}
```

## Development

```bash
npm install
npm run dev      # local dev server via wrangler
npm run deploy   # deploy to Cloudflare Workers
```

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com) — serverless edge runtime
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — CLI for deployment
- Vanilla JS + CSS — zero dependencies on the frontend
  
## Note

331, 415 ... - Link you Threads
333, 417 ... - Name Threads

