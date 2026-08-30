#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [iconsetPath, outputPath] = process.argv.slice(2);
if (!iconsetPath || !outputPath) {
  console.error("Usage: build-icns.mjs ICONSET_DIRECTORY OUTPUT_ICNS");
  process.exit(1);
}

const representations = [
  ["icp4", "icon_16x16.png", 16],
  ["ic11", "icon_16x16@2x.png", 32],
  ["icp5", "icon_32x32.png", 32],
  ["ic12", "icon_32x32@2x.png", 64],
  ["ic07", "icon_128x128.png", 128],
  ["ic13", "icon_128x128@2x.png", 256],
  ["ic08", "icon_256x256.png", 256],
  ["ic14", "icon_256x256@2x.png", 512],
  ["ic09", "icon_512x512.png", 512],
  ["ic10", "icon_512x512@2x.png", 1024],
];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function readAlphaChannel(png, filename) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${filename} must be a non-interlaced 8-bit RGBA PNG`);
  }

  const idatChunks = [];
  let offset = pngSignature.length;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error(`${filename} has a truncated PNG chunk`);
    if (type === "IDAT") idatChunks.push(png.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const encoded = zlib.inflateSync(Buffer.concat(idatChunks));
  if (encoded.length !== height * (stride + 1)) {
    throw new Error(`${filename} has an unexpected PNG scanline size`);
  }

  const alpha = Buffer.alloc(width * height);
  let previous = Buffer.alloc(stride);
  let encodedOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[encodedOffset];
    encodedOffset += 1;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedOffset + x];
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`${filename} uses unsupported PNG filter ${filter}`);
      current[x] = (raw + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) alpha[(y * width) + x] = current[(x * 4) + 3];
    encodedOffset += stride;
    previous = current;
  }
  return { alpha, width, height };
}

function validateTransparentCanvas(png, filename) {
  const { alpha, width, height } = readAlphaChannel(png, filename);
  const corners = [
    alpha[0],
    alpha[width - 1],
    alpha[(height - 1) * width],
    alpha[(height * width) - 1],
  ];
  if (corners.some((value) => value !== 0)) {
    throw new Error(`${filename} must have fully transparent corners`);
  }
  const nonOpaquePixels = alpha.reduce((count, value) => count + (value < 255 ? 1 : 0), 0);
  if (nonOpaquePixels < width * height * 0.05) {
    throw new Error(`${filename} must keep at least 5% of its canvas transparent`);
  }
}

const chunks = representations.map(([type, filename, expectedSize]) => {
  const png = fs.readFileSync(path.join(iconsetPath, filename));
  if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`${filename} is not a PNG file`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${filename} must be ${expectedSize}x${expectedSize}, got ${width}x${height}`);
  }
  validateTransparentCanvas(png, filename);

  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
});

const payload = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(header.length + payload.length, 4);
fs.writeFileSync(outputPath, Buffer.concat([header, payload]), { mode: 0o644 });
