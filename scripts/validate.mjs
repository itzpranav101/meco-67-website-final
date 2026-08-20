import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = ['server.mjs', 'package.json', '.env.example', 'public/index.html', 'public/styles.css', 'public/app.js', 'README.md'];
let failed = false;
for (const file of required) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
    console.error(`Missing or empty: ${file}`);
    failed = true;
  } else {
    console.log(`OK ${file}`);
  }
}
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
const checks = [
  ['Meco branding', /Meco/gi.test(html)],
  ['Clerk client', /mountSignIn|mountSignUp/.test(js)],
  ['Real face descriptor', /withFaceDescriptor/.test(js)],
  ['AssemblyAI upload', /assemblyai\.com\/v2\/upload/.test(server)],
  ['Speaker diarisation', /speaker_labels:\s*true/.test(server)],
  ['Gemini summary', /generativelanguage\.googleapis\.com/.test(server)],
  ['Groq fallback', /api\.groq\.com/.test(server)],
  ['Appwrite persistence', /tablesdb/.test(server)],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('Meco validation passed.');
