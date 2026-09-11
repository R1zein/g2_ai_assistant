import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import sharp from 'sharp';

process.env.ENCRYPTION_KEY ??= 'a-test-passphrase-long-enough-to-pass';
process.env.GOOGLE_CLIENT_ID ??= 'test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-secret';

const { renderFrame, clampToContainer, RenderError } = await import('../dist/photos/render.js');

/** Serves one real JPEG, so the test exercises download + decode + dither. */
async function withImageHost(fn) {
  const width = 600;
  const height = 400;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round((255 * x) / width);
      raw[i + 1] = Math.round((255 * y) / height);
      raw[i + 2] = 96;
    }
  }
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

  const server = createServer((req, res) => {
    if (req.url === '/photo.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(jpeg);
    } else if (req.url === '/not-an-image') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>nope</html>');
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('clampToContainer holds the firmware limits', () => {
  // Image containers accept 20-288 wide and 20-144 tall; anything else is rejected.
  assert.deepEqual(clampToContainer(288, 144), { width: 288, height: 144 });
  assert.deepEqual(clampToContainer(576, 288), { width: 288, height: 144 });
  assert.deepEqual(clampToContainer(4, 4), { width: 20, height: 20 });
});

test('a real JPEG renders to exactly one byte per pixel', async () => {
  await withImageHost(async (base) => {
    const frame = await renderFrame('test-1', `${base}/photo.jpg`, { width: 288, height: 144 });

    assert.equal(frame.width, 288);
    assert.equal(frame.height, 144);
    assert.equal(frame.format, 'byte');

    const pixels = Buffer.from(frame.pixelsBase64, 'base64');
    assert.equal(pixels.length, 288 * 144);
    assert.ok(pixels.every((v) => v <= 15), 'a pixel exceeded the 4-bit range');
  });
});

test('nibble format halves the payload', async () => {
  await withImageHost(async (base) => {
    const frame = await renderFrame('test-2', `${base}/photo.jpg`, {
      width: 288,
      height: 144,
      format: 'nibble',
    });

    const pixels = Buffer.from(frame.pixelsBase64, 'base64');
    assert.equal(pixels.length, (288 / 2) * 144);
  });
});

test('a gradient uses most of the available levels', async () => {
  await withImageHost(async (base) => {
    const frame = await renderFrame('test-3', `${base}/photo.jpg`, { width: 288, height: 144 });
    const levels = new Set(Buffer.from(frame.pixelsBase64, 'base64'));
    // A gradient that collapsed to a handful of levels would mean the contrast
    // stretch or the dither had failed.
    assert.ok(levels.size >= 12, `only ${levels.size} distinct levels`);
  });
});

test('a non-image response is refused instead of being decoded as garbage', async () => {
  await withImageHost(async (base) => {
    await assert.rejects(() => renderFrame('test-4', `${base}/not-an-image`), RenderError);
  });
});

test('a dead host surfaces as a render error', async () => {
  await withImageHost(async (base) => {
    await assert.rejects(() => renderFrame('test-5', `${base}/missing.jpg`), RenderError);
  });
});
