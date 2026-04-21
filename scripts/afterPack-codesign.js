const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function exec(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
    });
}

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== "darwin") return;

    const appOutDir = context.appOutDir;
    const apps = fs.readdirSync(appOutDir).filter((name) => name.endsWith(".app"));
    if (apps.length === 0) {
        throw new Error(`[afterPack] no .app found in ${appOutDir}`);
    }

    const appPath = path.join(appOutDir, apps[0]);

    await exec("codesign", ["--force", "--deep", "--sign", "-", appPath]);

    const verify = await exec("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const msg = `${verify.stdout}\n${verify.stderr}`.trim();
    if (msg.includes("code has no resources but signature indicates they must be present")) {
        throw new Error(`[afterPack] codesign verify still reports resource warning for ${appPath}:\n${msg}`);
    }
};

