import express from "express";
import compression from "compression";
import fetch from "node-fetch";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import stream from "stream";
import { promisify } from "util";

const pipeline = promisify(stream.pipeline);

const app = express();
const PORT = process.env.PORT || 3000;


const TILE_SOURCE = "https://tiles.openrailwaymap.org/standard";
const MAX_ZOOM = 17;
const MIN_ZOOM = 6;

const HUNGARY_BBOX = {
  minLat: 34.6474761852544,
  maxLat: 62.87663309316957,
  minLng: -22.391810078706936,
  maxLng: 52.519193444206856
};

// Memory cache
const MEM_CACHE_LIMIT = 300;
const memCache = new Map();

// S3 / Object Storage config
const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
const BUCKET_NAME = process.env.S3_BUCKET;

/* ========================================== */

app.use(compression());

function tileToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tileToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function isHungaryTile(z, x, y) {
  const lon = tileToLon(x + 0.5, z);
  const lat = tileToLat(y + 0.5, z);
  return (
    lat >= HUNGARY_BBOX.minLat &&
    lat <= HUNGARY_BBOX.maxLat &&
    lon >= HUNGARY_BBOX.minLng &&
    lon <= HUNGARY_BBOX.maxLng
  );
}

function memGet(key) {
  if (!memCache.has(key)) return null;
  const val = memCache.get(key);
  memCache.delete(key);
  memCache.set(key, val); // LRU refresh
  return val;
}

function memSet(key, buffer) {
  memCache.set(key, buffer);
  if (memCache.size > MEM_CACHE_LIMIT) {
    memCache.delete(memCache.keys().next().value);
  }
}

/* ================= ROUTE ================= */

app.get("/tiles/:z/:x/:y.png", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  if (z < MIN_ZOOM || z > MAX_ZOOM) return res.status(404).end();
  if (!isHungaryTile(z, x, y)) return res.status(204).end();

  const key = `${z}/${x}/${y}.png`;

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Type", "image/png");

  // Memory cache
  const memTile = memGet(key);
  if (memTile) {
    res.setHeader("X-Tile-Cache", "MEM");
    return res.end(memTile);
  }

  try {
    // Object storage cache
    const s3Obj = await s3.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    }));

    const chunks = [];
    await pipeline(
      s3Obj.Body,
      new stream.Writable({
        write(chunk, _, cb) {
          chunks.push(chunk);
          cb();
        }
      })
    );
    const buffer = Buffer.concat(chunks);
    memSet(key, buffer);

    res.setHeader("X-Tile-Cache", "S3");
    return res.end(buffer);

  } catch (err) {
    if (err.name !== "NoSuchKey") {
      console.error("S3 error:", err);
      return res.status(500).end();
    }
  }

  // Fetch upstream
  try {
    const url = `${TILE_SOURCE}/${z}/${x}/${y}.png`;
    const response = await fetch(url, {
      headers: { "User-Agent": "HU-OpenRailwayMap-TileCache" }
    });

    if (!response.ok) return res.status(response.status).end();

    const buffer = await response.buffer();

    // Save to object storage
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "image/png"
    }));

    memSet(key, buffer);
    res.setHeader("X-Tile-Cache", "MISS");
    res.end(buffer);

  } catch (err) {
    console.error("Tile fetch error:", err);
    res.status(500).end();
  }
});

/* ================= META ================= */

app.get("/", (_, res) => {
  res.send("🚆 Hungary OpenRailwayMap tile cache running");
});

app.listen(PORT, () => {
  console.log(`🚆 Tile cache listening on port ${PORT}`);
});
