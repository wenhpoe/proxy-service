const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_ADMIN_PASSWORD = "123456";

function renderDefaultEnv() {
    return [
        `PROXY_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}`,
        `PROXY_ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}`,
        "",
    ].join("\n");
}

function main() {
    const root = path.join(__dirname, "..");
    const src = path.join(root, ".env");
    const outDir = path.join(root, "build");
    const dst = path.join(outDir, "bundled.env");

    try {
        fs.mkdirSync(outDir, { recursive: true });
    } catch {
        // ignore
    }

    if (!fs.existsSync(src)) {
        fs.writeFileSync(dst, renderDefaultEnv(), "utf8");
        process.stdout.write(`ℹ️ No proxy-service/.env found; wrote default bundled env (${DEFAULT_ADMIN_PASSWORD}).\n`);
        return;
    }

    const content = fs.readFileSync(src, "utf8");
    fs.writeFileSync(dst, content);
    process.stdout.write(`✅ Bundled env: ${dst}\n`);
}

main();
