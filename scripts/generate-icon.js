const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

function u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n >>> 0, 0);
    return b;
}

function u32le(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function u32be(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function mix3(c1, c2, t) {
    return [
        lerp(c1[0], c2[0], t),
        lerp(c1[1], c2[1], t),
        lerp(c1[2], c2[2], t),
    ];
}

function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mul3(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
}

function length2(x, y) {
    return Math.sqrt(x * x + y * y);
}

function capsuleSdf(px, py, ax, ay, bx, by, r) {
    // Distance to a line segment with rounded ends (capsule).
    const pax = px - ax;
    const pay = py - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const baLen2 = bax * bax + bay * bay;
    const h = baLen2 > 0 ? clamp01((pax * bax + pay * bay) / baLen2) : 0;
    const dx = pax - bax * h;
    const dy = pay - bay * h;
    return Math.sqrt(dx * dx + dy * dy) - r;
}

function ringSdf(x, y, cx, cy, r, thickness) {
    const d = length2(x - cx, y - cy) - r;
    return Math.abs(d) - thickness * 0.5;
}

function compositeOver(dst, srcRgb, srcA) {
    const a = clamp01(srcA);
    return {
        rgb: add3(mul3(srcRgb, a), mul3(dst.rgb, 1 - a)),
        a: a + dst.a * (1 - a),
    };
}

function render(size) {
    const png = new PNG({ width: size, height: size });

    // Transparent background + modern "link" mark (proxy bridge).
    // Colors match overall project vibe, but slightly more "network/tool" (teal -> blue).
    const cA = [0x2b, 0x6f, 0x6a]; // teal
    const cB = [0x2a, 0x63, 0xb7]; // blue
    const cHi = [0xff, 0xff, 0xff]; // highlight

    const to01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
    const A = to01(cA);
    const B = to01(cB);
    const HI = to01(cHi);

    const aa = 2.0 / size; // antialias in normalized coords

    // Geometry in normalized [-1..1]
    const n1 = { x: -0.34, y: -0.18 };
    const n2 = { x: 0.34, y: 0.18 };
    const ringR = 0.24;
    const ringT = 0.12;
    const linkR = 0.11;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size;
            const v = (y + 0.5) / size;
            const nx = u * 2 - 1;
            const ny = v * 2 - 1;

            // Transparent base
            let out = { rgb: [0, 0, 0], a: 0 };

            // Main SDF (2 rings + bridge capsule)
            const dRing1 = ringSdf(nx, ny, n1.x, n1.y, ringR, ringT);
            const dRing2 = ringSdf(nx, ny, n2.x, n2.y, ringR, ringT);
            const dBridge = capsuleSdf(nx, ny, n1.x + 0.18, n1.y + 0.12, n2.x - 0.18, n2.y - 0.12, linkR);
            const dMark = Math.min(dBridge, Math.min(dRing1, dRing2));

            // Shadow (keeps legibility on light/dark wallpapers)
            const dShadow = Math.min(
                ringSdf(nx, ny, n1.x + 0.06, n1.y + 0.06, ringR, ringT),
                Math.min(
                    ringSdf(nx, ny, n2.x + 0.06, n2.y + 0.06, ringR, ringT),
                    capsuleSdf(
                        nx,
                        ny,
                        n1.x + 0.24,
                        n1.y + 0.18,
                        n2.x - 0.12,
                        n2.y - 0.06,
                        linkR,
                    ),
                ),
            );
            const aShadow = (1 - smoothstep(0, aa * 8.0, dShadow)) * 0.20;
            out = compositeOver(out, [0, 0, 0], aShadow);

            // Gradient fill
            const aMark = 1 - smoothstep(0, aa * 3.0, dMark);
            const g = clamp01(0.60 * u + 0.40 * (1 - v));
            const base = mix3(A, B, g);
            out = compositeOver(out, base, aMark);

            // Soft highlight along top-left edges
            const edge = 1 - smoothstep(aa * 0.7, aa * 5.0, dMark);
            const hiG = clamp01(0.75 * (1 - v) + 0.25 * (1 - u));
            const hi = mix3(HI, base, 0.60);
            out = compositeOver(out, hi, edge * 0.11 * hiG);

            // Two small nodes (dots) imply "proxy hops"
            const dotA = length2(nx - n1.x, ny - (n1.y + 0.36)) - 0.065;
            const dotB = length2(nx - n2.x, ny - (n2.y - 0.36)) - 0.065;
            const aDotA = 1 - smoothstep(0, aa * 3.2, dotA);
            const aDotB = 1 - smoothstep(0, aa * 3.2, dotB);
            const dotCol = mix3(base, HI, 0.16);
            out = compositeOver(out, dotCol, aDotA * 0.95);
            out = compositeOver(out, dotCol, aDotB * 0.95);

            const i = (y * size + x) * 4;
            png.data[i + 0] = Math.round(clamp01(out.rgb[0]) * 255);
            png.data[i + 1] = Math.round(clamp01(out.rgb[1]) * 255);
            png.data[i + 2] = Math.round(clamp01(out.rgb[2]) * 255);
            png.data[i + 3] = Math.round(clamp01(out.a) * 255);
        }
    }

    return png;
}

function buildIco(pngBuffers) {
    // ICO can embed PNG images (Vista+). We'll include multiple sizes for better scaling.
    const count = pngBuffers.length;
    const header = Buffer.concat([u16le(0), u16le(1), u16le(count)]);

    let offset = 6 + 16 * count;
    const entries = [];
    const images = [];

    for (const { size, data } of pngBuffers) {
        const width = size === 256 ? 0 : size;
        const height = size === 256 ? 0 : size;

        const entry = Buffer.concat([
            Buffer.from([width & 0xff]),
            Buffer.from([height & 0xff]),
            Buffer.from([0]), // color count
            Buffer.from([0]), // reserved
            u16le(1), // planes
            u16le(32), // bit count
            u32le(data.length),
            u32le(offset),
        ]);

        entries.push(entry);
        images.push(data);
        offset += data.length;
    }

    return Buffer.concat([header, ...entries, ...images]);
}

function buildIcns(pngByType) {
    const chunks = [];
    let totalSize = 8;

    for (const { type, data } of pngByType) {
        const chunkSize = 8 + data.length;
        chunks.push(Buffer.concat([Buffer.from(type, "ascii"), u32be(chunkSize), data]));
        totalSize += chunkSize;
    }

    return Buffer.concat([Buffer.from("icns", "ascii"), u32be(totalSize), ...chunks]);
}

function main() {
    const outDir = path.join(__dirname, "..", "build");
    fs.mkdirSync(outDir, { recursive: true });

    const png1024 = PNG.sync.write(render(1024));
    const png512 = PNG.sync.write(render(512));
    const png256 = PNG.sync.write(render(256));
    const png64 = PNG.sync.write(render(64));
    const png48 = PNG.sync.write(render(48));
    const png32 = PNG.sync.write(render(32));
    const png16 = PNG.sync.write(render(16));

    const outPng = path.join(outDir, "icon.png");
    fs.writeFileSync(outPng, png1024);
    process.stdout.write(`✅ Wrote ${outPng}\n`);

    const ico = buildIco([
        { size: 256, data: png256 },
        { size: 64, data: png64 },
        { size: 48, data: png48 },
        { size: 32, data: png32 },
        { size: 16, data: png16 },
    ]);
    const outIco = path.join(outDir, "icon.ico");
    fs.writeFileSync(outIco, ico);
    process.stdout.write(`✅ Wrote ${outIco}\n`);

    const icns = buildIcns([
        { type: "ic09", data: png512 },
        { type: "ic10", data: png1024 },
    ]);
    const outIcns = path.join(outDir, "icon.icns");
    fs.writeFileSync(outIcns, icns);
    process.stdout.write(`✅ Wrote ${outIcns}\n`);
}

main();

