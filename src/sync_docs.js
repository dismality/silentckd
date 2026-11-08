// Copies the documents the website offers for download from docs/ to demo/docs/.
// Runs automatically before each Cloudflare deploy (see wrangler.jsonc). To run it by hand: node src/sync_docs.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const files = ["model_card.md", "validation_report.md", "related_work.md", "deployment_plan.md"];

for (const f of files) fs.copyFileSync(path.join(root, "docs", f), path.join(root, "demo", "docs", f));
console.log("Copied", files.length, "documents to demo/docs");
