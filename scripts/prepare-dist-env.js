const fs = require("fs");
const path = require("path");

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
        try {
            if (fs.existsSync(dst)) fs.unlinkSync(dst);
        } catch {
            // ignore
        }
        process.stdout.write("ℹ️ No proxy-service/.env found; skip bundling env.\n");
        return;
    }

    const content = fs.readFileSync(src, "utf8");
    fs.writeFileSync(dst, content);
    process.stdout.write(`✅ Bundled env: ${dst}\n`);
}

main();

