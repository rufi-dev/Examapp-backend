// Worker thread for sheetOmr: OpenCV.js analysis off the API event loop.
const { parentPort } = require("worker_threads");
const { analyzeJpeg, analyzeGlyphsJpeg, analyzeBoxInkJpeg } = require("./sheetOmr");

const RUNNERS = { glyphs: analyzeGlyphsJpeg, boxink: analyzeBoxInkJpeg };

parentPort.on("message", async ({ id, kind, buffer, opts }) => {
  try {
    const run = RUNNERS[kind] || analyzeJpeg;
    const result = await run(Buffer.from(buffer), opts);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e) });
  }
});
