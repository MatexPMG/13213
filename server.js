import express from "express";
import compression from "compression";
import fetch from "node-fetch";  // now works
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import stream from "stream";
import { promisify } from "util";

const app = express();
const PORT = process.env.PORT || 3000;

const TILE_SOURCE = "https://tiles.openrailwaymap.org/standard";
const MAX_ZOOM = 17;
const MIN_ZOOM = 6;

// Memory cache
const MEM_CACHE_LIMIT = 300;
const memCache = new Map();

// Object Storage client
const s3 = new S3Client({
  endpoint: process.env.OBJ_ENDPOINT,
  region: "nbg1",
  credentials: {
    accessKeyId: process.env.OBJ_KEY,
    secretAccessKey: process.env.OBJ_SECRET
  },
});
const BUCKET = process.env.OBJ_BUCKET;

const pipeline = promisify(stream.pipeline);

function memGet(key) {
  if (!memCache.has(key)) return null;
  const val = memCache.get(key);
  memCache.delete(key);
  memCache.set(key, val);
  return val;
}

function memSet(key, buffer) {
  memCache.set(key, buffer);
  if (memCache.size > MEM_CACHE_LIMIT) {
    memCache.delete(memCache.keys().next().value);
  }
}

async function getTileFromS3(key) {
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await s3.send(cmd);
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (err) {
    if (err.name === "NoSuchKey") return null;
    throw err;
  }
}

async function putTileToS3(key, buffer) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: "image/png" });
  await s3.send(cmd);
}

app.use(compression());

// Route: serve tiles
app.get("/tiles/:z/:x/:y.png", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  if (z < MIN_ZOOM || z > MAX_ZOOM) return res.status(404).end();

  const key = `${z}/${x}/${y}.png`;

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Type", "image/png");

  // Memory cache
  const memTile = memGet(key);
  if (memTile) {
    res.setHeader("X-Tile-Cache", "MEM");
    return res.end(memTile);
  }

  // Object Storage cache
  const s3Tile = await getTileFromS3(key);
  if (s3Tile) {
    memSet(key, s3Tile);
    res.setHeader("X-Tile-Cache", "S3");
    return res.end(s3Tile);
  }

  // Fetch upstream if missing
  try {
    const response = await fetch(`${TILE_SOURCE}/${z}/${x}/${y}.png`, {
      headers: { "User-Agent": "HU-OpenRailwayMap-TileCache" }
    });
    if (!response.ok) return res.status(response.status).end();

    const buffer = await response.buffer();

    // Store to object storage + memory
    await putTileToS3(key, buffer);
    memSet(key, buffer);

    res.setHeader("X-Tile-Cache", "MISS");
    res.end(buffer);
  } catch (err) {
    console.error("Tile error:", err);
    res.status(500).end();
  }
});

app.get("/", (_, res) => res.send("🚆 Tile cache running on Railway (Object Storage + CDN)"));

app.listen(PORT, () => console.log(`🚆 Tile cache listening on port ${PORT}`));
